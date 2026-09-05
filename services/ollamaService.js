const aiConfig = require("../config/ai");

// Runtime model routing state. A paid/pro model can be configured as primary
// while a Free/starter account only has access to smaller cloud models. When
// Ollama explicitly rejects one model for plan/usage reasons, skip that model
// for a short cooldown and keep the Assistant alive on the next accessible
// candidate. A successful fallback becomes sticky for this Node process so
// every chat turn does not repeat the same rejected paid-model request.
const blockedModels = new Map();
const blockedModelErrors = new Map();
let preferredRuntimeModel = null;

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

function isModelAccessError(status, message) {
  const code = Number(status);
  const text = String(message || "").toLowerCase();
  if (![400, 402, 403].includes(code)) return false;
  return /requires? (?:a )?subscription|subscription or extra usage|extra usage|upgrade for access|add extra usage|usage credits?|insufficient (?:usage|credits?|balance)|not available (?:on|for) (?:your|this) plan|plan does not include|model access/.test(text);
}

function authError(status, message) {
  if (![401, 403].includes(Number(status)) || isModelAccessError(status, message)) return null;
  const error = new Error(message || "Ollama Cloud authentication failed");
  error.code = "OLLAMA_AUTH_ERROR";
  error.publicMessage = "Ollama Cloud authentication failed. Check or rotate OLLAMA_API_KEY.";
  return error;
}

function modelAccessError(status, message, model) {
  if (!isModelAccessError(status, message)) return null;
  const error = new Error(message || `Ollama model '${model}' is not available on the current plan`);
  error.status = Number(status);
  error.code = "OLLAMA_MODEL_ACCESS_ERROR";
  error.model = String(model || "");
  error.publicMessage = "The preferred cloud model is not available on this Ollama plan. The backend will try an accessible fallback model.";
  return error;
}

function blockModel(model, error) {
  const key = String(model || "").trim();
  if (!key) return;
  blockedModels.set(key, Date.now() + aiConfig.ollamaModelAccessCooldownMs);
  blockedModelErrors.set(key, error);
  if (preferredRuntimeModel === key) preferredRuntimeModel = null;
}

function modelIsBlocked(model) {
  const key = String(model || "").trim();
  const until = blockedModels.get(key) || 0;
  if (!until) return false;
  if (until <= Date.now()) {
    blockedModels.delete(key);
    blockedModelErrors.delete(key);
    return false;
  }
  return true;
}

function orderedCandidates(candidates, allowSticky = true) {
  const unique = [...new Set((candidates || []).map((value) => String(value || "").trim()).filter(Boolean))];
  const available = unique.filter((model) => !modelIsBlocked(model));
  if (!available.length) return [];
  if (allowSticky && preferredRuntimeModel && available.includes(preferredRuntimeModel)) {
    return [preferredRuntimeModel, ...available.filter((model) => model !== preferredRuntimeModel)];
  }
  return available;
}

async function chatWithModel(model, messages, {
  json,
  temperature,
  timeoutMs,
  numCtx,
  numPredict,
  think,
  tools,
  keepAlive,
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
        ...(Array.isArray(tools) && tools.length ? { tools } : {}),
        ...(keepAlive ? { keep_alive: keepAlive } : {}),
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
      const access = modelAccessError(response.status, message, model);
      if (access) throw access;
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

async function ollamaChatRaw(messages, {
  json = false,
  temperature = 0.1,
  timeoutMs = aiConfig.ollamaTimeoutMs,
  numCtx = aiConfig.ollamaNumCtx,
  numPredict = aiConfig.ollamaNumPredict,
  think = aiConfig.ollamaThinking,
  model = null,
  tools = null,
  keepAlive = null,
} = {}) {
  const configured = model ? [String(model).trim()] : aiConfig.ollamaModelCandidates;
  const candidates = orderedCandidates(configured, !model);
  let lastError;

  if (!candidates.length) {
    const blocked = configured.map((name) => blockedModelErrors.get(String(name).trim())).filter(Boolean);
    const error = blocked[0] || new Error("No Ollama model candidate is currently available");
    if (!error.code) error.code = "OLLAMA_MODEL_ACCESS_ERROR";
    throw error;
  }

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
        tools,
        keepAlive,
      });
      if (!model) preferredRuntimeModel = candidate;
      return body;
    } catch (error) {
      lastError = error;
      const retryableAlias = error.code === "OLLAMA_MODEL_ALIAS_ERROR";
      const retryableAccess = error.code === "OLLAMA_MODEL_ACCESS_ERROR";
      if (retryableAccess) blockModel(candidate, error);

      const hasNext = index < candidates.length - 1;
      if ((retryableAlias || retryableAccess) && hasNext) {
        const reason = retryableAccess ? "not included in the current Ollama plan/usage" : "alias unavailable";
        console.warn(`[Ollama] Model '${candidate}' ${reason}; trying fallback '${candidates[index + 1]}'`);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("Ollama request failed");
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
  const configured = model ? [String(model).trim()] : aiConfig.ollamaModelCandidates;
  const candidates = orderedCandidates(configured, !model);
  let lastError;

  if (!candidates.length) {
    const blocked = configured.map((name) => blockedModelErrors.get(String(name).trim())).filter(Boolean);
    const error = blocked[0] || new Error("No Ollama model candidate is currently available");
    if (!error.code) error.code = "OLLAMA_MODEL_ACCESS_ERROR";
    throw error;
  }

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
      if (!model) preferredRuntimeModel = candidate;
      return json ? parseJsonLoose(text) : text;
    } catch (error) {
      lastError = error;
      const retryableAlias = error.code === "OLLAMA_MODEL_ALIAS_ERROR";
      const retryableAccess = error.code === "OLLAMA_MODEL_ACCESS_ERROR";
      if (retryableAccess) blockModel(candidate, error);

      const hasNext = index < candidates.length - 1;
      if ((retryableAlias || retryableAccess) && hasNext) {
        const reason = retryableAccess ? "not included in the current Ollama plan/usage" : "alias unavailable";
        console.warn(`[Ollama] Model '${candidate}' ${reason}; trying fallback '${candidates[index + 1]}'`);
        continue;
      }
      throw error;
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
      activeRuntimeModel: preferredRuntimeModel || null,
      modelCandidates: aiConfig.ollamaModelCandidates,
      blockedModels: [...blockedModels.entries()].filter(([, until]) => until > Date.now()).map(([name, until]) => ({ name, retryAfter: new Date(until).toISOString() })),
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

function getOllamaRuntimeState() {
  return {
    configuredModel: aiConfig.ollamaModel,
    activeRuntimeModel: preferredRuntimeModel || null,
    candidates: [...aiConfig.ollamaModelCandidates],
    blockedModels: [...blockedModels.entries()]
      .filter(([, until]) => until > Date.now())
      .map(([name, until]) => ({ name, retryAfter: new Date(until).toISOString(), reason: blockedModelErrors.get(name)?.message || "model access unavailable" })),
  };
}

module.exports = { ollamaChat, ollamaChatRaw, checkOllama, thinkValueForModel, getOllamaRuntimeState, isModelAccessError };
