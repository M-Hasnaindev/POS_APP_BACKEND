function numberFromEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

module.exports = {
  ollamaBaseUrl: String(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
  ollamaModel: String(process.env.OLLAMA_MODEL || "qwen3:1.7b"),
  ollamaTimeoutMs: numberFromEnv("OLLAMA_TIMEOUT_MS", 90000, 5000, 300000),
  ollamaNumCtx: numberFromEnv("OLLAMA_NUM_CTX", 16384, 4096, 65536),
  ollamaNumPredict: numberFromEnv("OLLAMA_NUM_PREDICT", 4096, 512, 8192),
  sqlTimeoutMs: numberFromEnv("AI_SQL_TIMEOUT_MS", 45000, 5000, 120000),
  maxRows: numberFromEnv("AI_MAX_ROWS", 200, 10, 1000),
  maxQuestionLength: numberFromEnv("AI_MAX_QUESTION_LENGTH", 1200, 100, 4000),
};
