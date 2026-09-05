function numberFromEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function boolFromEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return fallback;
}

function normalizeThinkLevel(value, fallback = false) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["false", "0", "off", "no", "none"].includes(raw)) return false;
  if (["true", "1", "on", "yes"].includes(raw)) return true;
  if (["low", "medium", "high", "max"].includes(raw)) return raw;
  return fallback;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

const ollamaBaseUrl = String(process.env.OLLAMA_BASE_URL || "https://ollama.com")
  .trim()
  .replace(/\/+$/, "");
const ollamaCloud = /^https:\/\/(?:www\.)?ollama\.com(?:\/|$)/i.test(ollamaBaseUrl);
const ollamaModel = String(
  process.env.OLLAMA_MODEL || (ollamaCloud ? "gpt-oss:20b-cloud" : "qwen3:1.7b"),
).trim();

const explicitCandidates = String(process.env.OLLAMA_MODEL_CANDIDATES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// Ollama's library/CLI and direct cloud API can expose slightly different aliases.
// The configured model is always tried first; these cloud aliases are only retried
// when Ollama explicitly says the model name was not found.
const fallbackModels = String(process.env.OLLAMA_FALLBACK_MODELS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// Keep DeepSeek V4 Pro as the preferred model when the account has access, but
// never make the Assistant depend on that one paid model. Ollama Free accounts
// can expose only starter models, while paid/extra-usage accounts unlock larger
// models. These are ordered from strongest preferred model to lower-usage
// fallbacks. The runtime skips a model temporarily when Ollama returns an
// explicit subscription/extra-usage error, then continues with the next model.
const cloudCandidates = ollamaCloud
  ? [
      // Primary starter/low-usage reasoning model. GPT-OSS 20B supports tools
      // plus low/medium/high reasoning effort and is tuned for lower latency.
      "gpt-oss:20b-cloud",
      "gpt-oss:20b",
      // Low-usage reasoning/tool fallback with a very large context window.
      "nemotron-3-nano:30b-cloud",
      "nemotron-3-nano",
      // Multilingual fallback. This can require more cloud usage than the
      // starter models, so it is intentionally tried after low-usage models.
      "qwen3.5:cloud",
      "qwen3.5",
      // Paid/extra-usage fallbacks are last; the Assistant never depends on
      // them and will cooldown-skip them when the account has no access.
      "deepseek-v4-flash:cloud",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-pro:0813",
      "deepseek-v4-pro:cloud",
      "deepseek-v4-pro:0813-cloud",
    ]
  : [];

module.exports = {
  ollamaBaseUrl,
  ollamaCloud,
  ollamaApiKey: String(process.env.OLLAMA_API_KEY || process.env.OLLAMA_AUTH_TOKEN || "").trim(),
  ollamaModel,
  ollamaModelCandidates: unique([ollamaModel, ...explicitCandidates, ...fallbackModels, ...cloudCandidates]),
  ollamaFallbackModels: unique([...fallbackModels, ...cloudCandidates]),
  ollamaModelAccessCooldownMs: numberFromEnv("OLLAMA_MODEL_ACCESS_COOLDOWN_MS", 300000, 30000, 3600000),
  ollamaTimeoutMs: numberFromEnv("OLLAMA_TIMEOUT_MS", ollamaCloud ? 120000 : 90000, 5000, 300000),
  ollamaNumCtx: numberFromEnv("OLLAMA_NUM_CTX", 16384, 4096, 131072),
  ollamaNumPredict: numberFromEnv("OLLAMA_NUM_PREDICT", 4096, 256, 16384),
  ollamaThinking: normalizeThinkLevel(process.env.OLLAMA_THINKING, ollamaCloud ? "low" : false),
  ollamaPlannerThinkLevel: normalizeThinkLevel(process.env.OLLAMA_PLANNER_THINK_LEVEL, "medium"),
  ollamaComplexThinkLevel: normalizeThinkLevel(process.env.OLLAMA_COMPLEX_THINK_LEVEL, "high"),
  ollamaMaxThinking: boolFromEnv("OLLAMA_MAX_THINKING", false),
  ollamaAnalysisTimeoutMs: numberFromEnv("OLLAMA_ANALYSIS_TIMEOUT_MS", 48000, 10000, 90000),
  sqlTimeoutMs: numberFromEnv("AI_SQL_TIMEOUT_MS", 45000, 5000, 120000),
  maxRows: numberFromEnv("AI_MAX_ROWS", 200, 10, 1000),
  maxQuestionLength: numberFromEnv("AI_MAX_QUESTION_LENGTH", 1200, 100, 4000),
};
