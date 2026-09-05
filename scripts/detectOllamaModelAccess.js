require("dotenv").config();

const fs = require("fs");
const path = require("path");
const aiConfig = require("../config/ai");

const envPath = path.resolve(__dirname, "..", ".env");

function setEnvValue(name, value) {
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}=.*$`, "m");
  const line = `${name}=${value}`;
  if (re.test(text)) text = text.replace(re, line);
  else text += `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  fs.writeFileSync(envPath, text, "utf8");
}

async function probe(model) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${aiConfig.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiConfig.ollamaApiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply only with: ACCESS_OK" }],
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 16, num_ctx: 4096 },
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, status: response.status, message: String(body?.error || body?.message || `HTTP ${response.status}`) };
    const content = String(body?.message?.content || "");
    return { ok: /ACCESS_OK/i.test(content), status: response.status, message: content.slice(0, 120) };
  } catch (error) {
    return { ok: false, status: 0, message: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  if (!aiConfig.ollamaCloud) throw new Error(`OLLAMA_BASE_URL must point to https://ollama.com (current: ${aiConfig.ollamaBaseUrl})`);
  if (!aiConfig.ollamaApiKey) throw new Error("OLLAMA_API_KEY is missing in backend .env");

  console.log("Cherry POS - Ollama model access detection");
  console.log(`Testing ${aiConfig.ollamaModelCandidates.length} configured model aliases. API key will not be printed.`);

  let working = null;
  for (const model of aiConfig.ollamaModelCandidates) {
    process.stdout.write(`- ${model}: `);
    const result = await probe(model);
    if (result.ok) {
      console.log("ACCESSIBLE");
      working = model;
      break;
    }
    const short = result.message.replace(/\s+/g, " ").slice(0, 160);
    console.log(`unavailable${result.status ? ` [${result.status}]` : ""} - ${short}`);
  }

  if (!working) {
    console.error("\nNo configured Ollama cloud model is currently accessible.");
    console.error("Your API key may be valid, but the account needs starter usage, extra usage credits, or a plan that unlocks a model.");
    process.exitCode = 2;
    return;
  }

  setEnvValue("OLLAMA_MODEL", working);
  setEnvValue("OLLAMA_MODEL_ACCESS_COOLDOWN_MS", "300000");
  console.log(`\nSelected working model: ${working}`);
  console.log("Saved to backend .env. Restart Node after this command.");
})();
