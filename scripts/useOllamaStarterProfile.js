require("dotenv").config();

const fs = require("fs");
const path = require("path");

const envPath = path.resolve(__dirname, "..", ".env");
const settings = {
  OLLAMA_BASE_URL: "https://ollama.com",
  OLLAMA_MODEL: "gpt-oss:20b-cloud",
  OLLAMA_MODEL_CANDIDATES: "gpt-oss:20b-cloud,gpt-oss:20b,nemotron-3-nano:30b-cloud,nemotron-3-nano,qwen3.5:cloud,qwen3.5,deepseek-v4-flash:cloud,deepseek-v4-flash,deepseek-v4-pro",
  OLLAMA_FALLBACK_MODELS: "gpt-oss:20b,nemotron-3-nano:30b-cloud,nemotron-3-nano,qwen3.5:cloud,qwen3.5,deepseek-v4-flash:cloud,deepseek-v4-flash,deepseek-v4-pro",
  OLLAMA_MODEL_ACCESS_COOLDOWN_MS: "300000",
  OLLAMA_TIMEOUT_MS: "90000",
  OLLAMA_ANALYSIS_TIMEOUT_MS: "45000",
  OLLAMA_NUM_CTX: "16384",
  OLLAMA_NUM_PREDICT: "2048",
  OLLAMA_THINKING: "low",
  OLLAMA_PLANNER_THINK_LEVEL: "medium",
  OLLAMA_COMPLEX_THINK_LEVEL: "high",
  OLLAMA_MAX_THINKING: "false",
};

function setEnvValue(text, name, value) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}=.*$`, "m");
  const line = `${name}=${value}`;
  if (re.test(text)) return text.replace(re, line);
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
}

let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
for (const [name, value] of Object.entries(settings)) text = setEnvValue(text, name, value);
fs.writeFileSync(envPath, text, "utf8");

console.log("Cherry POS Ollama starter/fast reasoning profile saved to .env.");
console.log("Primary: gpt-oss:20b-cloud");
console.log("Normal reasoning: low | planner: medium | complex analysis: high");
console.log("Existing OLLAMA_API_KEY was preserved. Run: npm run detect:ollama-model");
