const aiConfig = require("../config/ai");

function cleanModelText(value) {
  return String(value || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function parseJsonLoose(text) {
  const cleaned = cleanModelText(text);
  const candidates = [cleaned];
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));
  let lastError;
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch (error) { lastError = error; }
  }
  throw lastError || new Error("Ollama returned invalid JSON");
}

function normalizeThink(value) {
  if (value === true || value === false) return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || ["false", "off", "none", "0"].includes(text)) return false;
  if (["true", "on", "1"].includes(text)) return true;
  if (["low", "medium", "high", "max"].includes(text)) return text;
  return false;
}

function thinkValueForModel(model, value) {
  const normalized = normalizeThink(value);
  if (typeof normalized !== "string") return normalized;

  // Ollama documents low/medium/high string levels for GPT-OSS. DeepSeek and
  // most other thinking models use a boolean think flag. Passing `high` to
  // DeepSeek can make normal chat work (think=false) while analysis requests
  // fail with HTTP 400. Preserve levels for GPT-OSS; use boolean thinking for
  // DeepSeek/Qwen/other models. `max` is reduced to GPT-OSS high because max is
  // not part of the generic API level contract.
  if (/gpt-oss/i.test(String(model || ""))) {
    return normalized === "max" ? "high" : normalized;
  }
  return true;
}

function requestHeaders() {
  if (aiConfig.ollamaCloud && !aiConfig.ollamaApiKey) {
    const error = new Error("OLLAMA_API_KEY is required when OLLAMA_BASE_URL points to ollama.com");
    error.code = "OLLAMA_API_KEY_MISSING";
    error.publicMessage = "Ollama Cloud API key is not configured on the backend.";
    throw error;
  }
  return {
    "Content-Type": "application/json",
    ...(aiConfig.ollamaApiKey ? { Authorization: `Bearer ${aiConfig.ollamaApiKey}` } : {}),
  };
}

function bodyErrorMessage(body, status) {
  return String(body?.error || body?.message || `Ollama returned HTTP ${status}`).trim();
}

function isModelAliasError(status, message) {
  if (![400, 404].includes(Number(status))) return false;
  return /model|manifest|not found|does not exist|unknown/i.test(String(message || ""));
}

function authError(status, message) {
  if (![401, 403].includes(Number(status))) return null;
  const error = new Error(message || "Ollama Cloud authentication failed");
  error.code = "OLLAMA_AUTH_ERROR";
  error.publicMessage = "Ollama Cloud authentication failed. Check or rotate OLLAMA_API_KEY.";
  return error;
}

async function chatWithModel(model, messages, {
  json,
  temperature,
  timeoutMs,
  numCtx,
  numPredict,
  think,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${aiConfig.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: requestHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        think: thinkValueForModel(model, think),
        ...(json ? { format: "json" } : {}),
        options: {
          temperature,
          num_ctx: numCtx,
          num_predict: numPredict,
        },
      }),
    });

    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = bodyErrorMessage(body, response.status);
      const auth = authError(response.status, message);
      if (auth) throw auth;
      const error = new Error(message);
      error.status = response.status;
      error.code = isModelAliasError(response.status, message) ? "OLLAMA_MODEL_ALIAS_ERROR" : "OLLAMA_HTTP_ERROR";
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Ollama request timed out");
      timeoutError.code = "OLLAMA_TIMEOUT";
      timeoutError.publicMessage = "AI response timed out. Please try again.";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function ollamaChat(messages, {
  json = false,
  temperature = 0.1,
  timeoutMs = aiConfig.ollamaTimeoutMs,
  numCtx = aiConfig.ollamaNumCtx,
  numPredict = aiConfig.ollamaNumPredict,
  think = aiConfig.ollamaThinking,
  model = null,
} = {}) {
  const candidates = model
    ? [String(model).trim()]
    : aiConfig.ollamaModelCandidates;
  let lastError;

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    try {
      const body = await chatWithModel(candidate, messages, {
        json,
        temperature,
        timeoutMs,
        numCtx,
        numPredict,
        think,
      });
      const text = cleanModelText(body?.message?.content);
      if (!text) throw new Error("Ollama returned an empty response");
      return json ? parseJsonLoose(text) : text;
    } catch (error) {
      lastError = error;
      const canRetryAlias = error.code === "OLLAMA_MODEL_ALIAS_ERROR" && index < candidates.length - 1;
      if (!canRetryAlias) throw error;
      console.warn(`[Ollama] Model alias '${candidate}' unavailable; trying '${candidates[index + 1]}'`);
    }
  }
  throw lastError || new Error("Ollama request failed");
}

async function checkOllama() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${aiConfig.ollamaBaseUrl}/api/tags`, {
      headers: requestHeaders(),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = bodyErrorMessage(body, response.status);
      return {
        available: false,
        provider: aiConfig.ollamaCloud ? "ollama-cloud" : "ollama-local",
        model: aiConfig.ollamaModel,
        message,
      };
    }
    const models = (body?.models || []).map((item) => String(item?.name || item?.model || "")).filter(Boolean);
    const configuredNames = aiConfig.ollamaModelCandidates.map((name) => name.replace(/:cloud$/i, ""));
    const visible = models.some((name) => {
      const normalized = name.replace(/:cloud$/i, "");
      return configuredNames.includes(normalized) || aiConfig.ollamaModelCandidates.includes(name);
    });
    return {
      available: true,
      provider: aiConfig.ollamaCloud ? "ollama-cloud" : "ollama-local",
      model: aiConfig.ollamaModel,
      authenticated: aiConfig.ollamaCloud ? Boolean(aiConfig.ollamaApiKey) : undefined,
      modelVisible: visible,
      models: models.slice(0, 50),
    };
  } catch (error) {
    return {
      available: false,
      provider: aiConfig.ollamaCloud ? "ollama-cloud" : "ollama-local",
      model: aiConfig.ollamaModel,
      message: error?.name === "AbortError" ? "Ollama health timed out" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { ollamaChat, checkOllama, thinkValueForModel };
