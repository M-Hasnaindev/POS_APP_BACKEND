"use strict";
/**
 * Claude agent proxy for the business assistant.
 *
 * The business data lives on the admin's device (local SQLite + attendance
 * cache), so the tools run on the device. This endpoint runs exactly one model
 * turn: it receives the conversation so far, streams Claude's reply back as
 * NDJSON, and returns the final assistant message. The device runs any tool
 * calls and posts the next turn. Nothing is stored on the server.
 *
 * The API key stays here (ANTHROPIC_API_KEY); the device never sees it.
 */
const { once } = require("node:events");
const Anthropic = require("@anthropic-ai/sdk");
const { SYSTEM_PROMPT, TOOLS, TOOL_NAMES } = require("./assistantAgentPrompt");
const usage = require("./assistantUsage");

const AnthropicClient = Anthropic.default || Anthropic;
const MODEL = String(process.env.ASSISTANT_MODEL || "claude-sonnet-5-5").trim();
const EFFORT = ["low", "medium", "high"].includes(process.env.ASSISTANT_EFFORT) ? process.env.ASSISTANT_EFFORT : "medium";
const MAX_MESSAGES = 160;
const MAX_TOKENS = 32000;
// Server-side fallback for refusals, and short progress notes between tool calls.
const BETAS = ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"];

let client = null;
function getClient() {
  const apiKey = String(process.env.ANTHROPIC_API_KEY || "").trim();
  if (!apiKey) return null;
  if (!client) client = new AnthropicClient({ apiKey, maxRetries: 3, timeout: 240000 });
  return client;
}

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

/**
 * Light shape check of the conversation the device sends. Blocks are passed to
 * the API unchanged (thinking blocks must round-trip byte for byte), so this
 * only rejects what can never be valid.
 */
function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return "messages must be a non-empty array";
  if (messages.length > MAX_MESSAGES) return "This chat is too long. Please start a new chat.";
  if (messages[0]?.role !== "user") return "The first message must come from the user";
  for (const message of messages) {
    if (!isObject(message) || !["user", "assistant"].includes(message.role)) return "Invalid message role";
    const { content } = message;
    if (typeof content === "string") { if (!content.trim()) return "Empty message"; continue; }
    if (!Array.isArray(content) || !content.length) return "Invalid message content";
    for (const block of content) {
      if (!isObject(block) || typeof block.type !== "string") return "Invalid content block";
      if (block.type === "tool_use" && !TOOL_NAMES.has(block.name)) return `Unknown tool ${block.name}`;
    }
  }
  return null;
}

function errorPayload(error) {
  if (error instanceof AnthropicClient.AuthenticationError || error instanceof AnthropicClient.PermissionDeniedError)
    return { code: "AI_AUTH", message: "The AI key is not valid. Please check the assistant settings." };
  if (error instanceof AnthropicClient.RateLimitError)
    return { code: "AI_RATE_LIMIT", message: "The AI is busy right now. Please try again in a minute." };
  if (error instanceof AnthropicClient.BadRequestError)
    return { code: "AI_BAD_REQUEST", message: "The AI could not read this chat. Please start a new chat." };
  if (error instanceof AnthropicClient.APIConnectionError)
    return { code: "AI_UNREACHABLE", message: "Could not reach the AI service. Please try again." };
  if (error instanceof AnthropicClient.APIError)
    return { code: "AI_UNAVAILABLE", message: "The AI service had a problem. Please try again." };
  return { code: "AI_FAILED", message: "The assistant stopped unexpectedly. Please try again." };
}

async function streamTurn(req, res) {
  const anthropic = getClient();
  if (!anthropic) return res.status(503).json({ success: false, code: "AI_NOT_CONFIGURED", message: "The AI assistant is not set up on the server yet." });
  const messages = req.body?.messages;
  const invalid = validateMessages(messages);
  if (invalid) return res.status(400).json({ success: false, code: "AI_BAD_REQUEST", message: invalid });

  // Daily question limit: only a new question is counted, before Claude is called.
  let quota = null;
  if (usage.isNewQuestion(messages)) {
    try {
      quota = await usage.consumeQuestion(req.user);
    } catch (error) {
      // Do not block the assistant when the usage table cannot be reached.
      console.error("[assistant-usage] check failed", error?.message || error);
    }
    if (quota && !quota.allowed) {
      return res.status(429).json({
        success: false,
        code: "AI_DAILY_LIMIT",
        message: `You have used all ${quota.limit} assistant questions for today. You can ask again after midnight.`,
        quota: { limit: quota.limit, used: quota.used, remaining: 0, resetsAt: quota.resetsAt },
      });
    }
  }
  const quotaInfo = quota ? { limit: quota.limit, used: quota.used, remaining: quota.remaining, resetsAt: quota.resetsAt } : null;

  const abort = new AbortController();
  const onClose = () => { if (!res.writableEnded) abort.abort(); };
  res.on("close", onClose);
  res.set("Content-Type", "application/x-ndjson; charset=utf-8");
  res.set("Cache-Control", "no-store");
  res.set("X-Accel-Buffering", "no");
  res.flushHeaders();

  const write = async (event) => {
    if (abort.signal.aborted) return;
    if (!res.write(JSON.stringify(event) + "\n")) await once(res, "drain", { signal: abort.signal }).catch(() => undefined);
  };
  const heartbeat = setInterval(() => { if (!abort.signal.aborted && !res.writableNeedDrain) res.write('{"type":"ping"}\n'); }, 10000);

  try {
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      betas: BETAS,
      fallbacks: "default",
      thinking: { type: "adaptive", display: "updates" },
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    }, { signal: abort.signal });

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        await write({ type: "tool", id: event.content_block.id, name: event.content_block.name });
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") await write({ type: "text", index: event.index, text: event.delta.text });
        else if (event.delta.type === "thinking_delta" && event.delta.thinking) await write({ type: "thinking", index: event.index, text: event.delta.thinking });
      }
    }
    const message = await stream.finalMessage();
    await write({
      type: "done",
      message: {
        id: message.id,
        model: message.model,
        content: message.content,
        stop_reason: message.stop_reason,
        stop_details: message.stop_details ?? null,
        usage: message.usage,
      },
      ...(quotaInfo ? { quota: quotaInfo } : {}),
    });
  } catch (error) {
    if (!abort.signal.aborted) {
      console.error("[assistant-agent]", error?.status || "", error?.message || error);
      // Claude could not answer, so this question does not use up the user's daily count.
      if (quota?.counted) await usage.refundQuestion(req.user, quota.day);
      await write({ type: "error", ...errorPayload(error) });
    }
  } finally {
    clearInterval(heartbeat);
    res.off("close", onClose);
    res.end();
  }
}

function status(_req, res) {
  res.json({ success: true, configured: Boolean(String(process.env.ANTHROPIC_API_KEY || "").trim()), model: MODEL });
}

async function quotaStatus(req, res) {
  try {
    res.json({ success: true, quota: await usage.readUsage(req.user) });
  } catch (error) {
    console.error("[assistant-usage] read failed", error?.message || error);
    res.status(500).json({ success: false, message: "Could not read today's assistant usage." });
  }
}

module.exports = { streamTurn, status, quotaStatus, validateMessages, errorPayload };
