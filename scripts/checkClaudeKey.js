// Checks that ANTHROPIC_API_KEY in .env works for the assistant model (never prints the key).
require("dotenv").config({ quiet: true });
const Anthropic = require("@anthropic-ai/sdk");
const A = Anthropic.default || Anthropic;
const key = String(process.env.ANTHROPIC_API_KEY || "").trim();
const model = String(process.env.ASSISTANT_MODEL || "claude-sonnet-5-5").trim();
if (!key) { console.log("ANTHROPIC_API_KEY is empty in .env"); process.exit(1); }
(async () => {
  try {
    const client = new A({ apiKey: key });
    const msg = await client.messages.create({ model, max_tokens: 200, output_config: { effort: "low" }, messages: [{ role: "user", content: "Reply with just: OK" }] });
    const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    console.log(`Key works. Model ${msg.model} replied: ${text.slice(0, 40)}`);
  } catch (error) {
    if (error instanceof A.AuthenticationError) console.log("The key is not valid (401). Create a new key and paste it again.");
    else if (error instanceof A.PermissionDeniedError) console.log("The key has no access to this model (403).");
    else if (error instanceof A.RateLimitError) console.log("Rate limited (429). Try again in a minute.");
    else if (error instanceof A.BadRequestError) console.log(`Request rejected (400): ${String(error.message).slice(0, 200)} - often means no credit on the account.`);
    else console.log(`Could not reach the API: ${String(error?.message || error).slice(0, 200)}`);
    process.exit(1);
  }
})();
