require("dotenv").config();

const aiConfig = require("../config/ai");
const { checkOllama, ollamaChat } = require("../services/ollamaService");

async function main() {
  if (!aiConfig.ollamaCloud) {
    throw new Error(`OLLAMA_BASE_URL is not cloud: ${aiConfig.ollamaBaseUrl}`);
  }
  if (!aiConfig.ollamaApiKey) {
    throw new Error("OLLAMA_API_KEY is blank. Run: npm run configure:ollama-cloud");
  }

  console.log("Testing Ollama Cloud...");
  console.log(`Base URL: ${aiConfig.ollamaBaseUrl}`);
  console.log(`Configured model: ${aiConfig.ollamaModel}`);

  const health = await checkOllama();
  if (!health.available) {
    throw new Error(`Cloud health failed: ${health.message || "unknown error"}`);
  }

  const answer = await ollamaChat([
    { role: "system", content: "You are a connectivity test. Follow the user exactly." },
    { role: "user", content: "Reply only with CLOUD_OK" },
  ], {
    temperature: 0,
    think: false,
    timeoutMs: Math.min(aiConfig.ollamaTimeoutMs, 120000),
    numCtx: 4096,
    numPredict: 32,
  });

  if (!/CLOUD_OK/i.test(answer)) {
    throw new Error(`Unexpected model response: ${answer.slice(0, 200)}`);
  }

  console.log("Ollama Cloud: OK");
  console.log(`Provider: ${health.provider || "ollama-cloud"}`);
  console.log(`Model response: ${answer}`);
}

main().catch((error) => {
  console.error(`Ollama Cloud test failed: ${error.message}`);
  process.exitCode = 1;
});
