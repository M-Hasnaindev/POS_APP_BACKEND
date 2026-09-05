/* eslint-disable no-console */
process.env.OLLAMA_BASE_URL = "https://ollama.com";
process.env.OLLAMA_API_KEY = "test-key";
process.env.OLLAMA_MODEL = "deepseek-v4-pro";
process.env.OLLAMA_MODEL_CANDIDATES = "deepseek-v4-pro,gpt-oss:20b-cloud";
process.env.OLLAMA_FALLBACK_MODELS = "gpt-oss:20b-cloud";
process.env.OLLAMA_MODEL_ACCESS_COOLDOWN_MS = "30000";

let calls = [];
global.fetch = async (_url, options) => {
  const body = JSON.parse(options.body || "{}");
  calls.push(body.model);
  if (body.model === "deepseek-v4-pro") {
    return {
      ok: false,
      status: 403,
      json: async () => ({ error: "this model requires a subscription or extra usage, upgrade for access" }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ model: body.model, message: { content: "FALLBACK_OK" } }),
  };
};

const { ollamaChat, getOllamaRuntimeState } = require("../services/ollamaService");

(async () => {
  const first = await ollamaChat([{ role: "user", content: "test" }], { think: false, timeoutMs: 5000, numPredict: 16 });
  if (first !== "FALLBACK_OK") throw new Error(`Unexpected first response: ${first}`);
  if (calls[0] !== "deepseek-v4-pro" || calls[1] !== "gpt-oss:20b-cloud") {
    throw new Error(`Fallback order wrong: ${calls.join(" -> ")}`);
  }

  calls = [];
  const second = await ollamaChat([{ role: "user", content: "test again" }], { think: false, timeoutMs: 5000, numPredict: 16 });
  if (second !== "FALLBACK_OK") throw new Error(`Unexpected second response: ${second}`);
  if (calls.length !== 1 || calls[0] !== "gpt-oss:20b-cloud") {
    throw new Error(`Sticky fallback failed: ${calls.join(" -> ")}`);
  }

  const state = getOllamaRuntimeState();
  if (state.activeRuntimeModel !== "gpt-oss:20b-cloud") throw new Error("Runtime model state not updated");
  if (!state.blockedModels.some((x) => x.name === "deepseek-v4-pro")) throw new Error("Rejected model was not cooldown-blocked");

  console.log("Ollama subscription/access fallback routing tests passed");
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
