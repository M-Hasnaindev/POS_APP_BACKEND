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

async function ollamaChat(messages, { json = false, temperature = 0.1 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), aiConfig.ollamaTimeoutMs);
  try {
    const response = await fetch(`${aiConfig.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: aiConfig.ollamaModel,
        messages,
        stream: false,
        think: false,
        ...(json ? { format: "json" } : {}),
        options: {
          temperature,
          num_ctx: aiConfig.ollamaNumCtx,
          num_predict: aiConfig.ollamaNumPredict,
        },
      }),
    });
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
    const body = await response.json();
    const text = cleanModelText(body?.message?.content);
    if (!text) throw new Error("Ollama returned an empty response");
    return json ? parseJsonLoose(text) : text;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Ollama request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function checkOllama() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${aiConfig.ollamaBaseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) return { available: false, model: aiConfig.ollamaModel };
    const body = await response.json();
    const models = (body.models || []).map((item) => item.name);
    return { available: true, model: aiConfig.ollamaModel, installed: models.includes(aiConfig.ollamaModel), models };
  } catch {
    return { available: false, model: aiConfig.ollamaModel };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { ollamaChat, checkOllama };
