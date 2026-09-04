const { thinkValueForModel } = require("../services/ollamaService");

function assert(condition, message) { if (!condition) throw new Error(message); }
assert(thinkValueForModel("deepseek-v4-pro", "high") === true, "DeepSeek high must normalize to boolean true");
assert(thinkValueForModel("deepseek-v4-pro:0813", "medium") === true, "DeepSeek medium must normalize to boolean true");
assert(thinkValueForModel("deepseek-v4-pro", false) === false, "DeepSeek false must stay false");
assert(thinkValueForModel("gpt-oss:120b", "high") === "high", "GPT-OSS level must be preserved");
assert(thinkValueForModel("gpt-oss:120b", "max") === "high", "GPT-OSS max must reduce to documented high");
console.log("Ollama thinking adapter tests passed");
