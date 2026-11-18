// Business assistant agent proxy: request validation, tool definitions and missing-key handling.
const assert = require("node:assert/strict");
// Empty (not deleted) so a later dotenv load cannot put the real key back.
process.env.ANTHROPIC_API_KEY = "";
const agent = require("../services/assistantAgent");
const { SYSTEM_PROMPT, TOOLS, TOOL_NAMES } = require("../services/assistantAgentPrompt");

// Tool definitions are valid, deterministic and match what the device implements.
assert.deepEqual([...TOOL_NAMES], ["run_sql", "accounting_query", "attendance_query", "forecast", "show_chart", "show_table", "export_report"]);
for (const tool of TOOLS) {
  assert.equal(tool.input_schema.type, "object");
  for (const key of tool.input_schema.required) assert.ok(tool.input_schema.properties[key], `${tool.name}.${key} is defined`);
  assert.ok(tool.description.length > 40);
}
assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(SYSTEM_PROMPT), "no timestamps in the cached system prompt");
assert.equal(JSON.stringify(require("../services/assistantAgentPrompt").TOOLS), JSON.stringify(TOOLS), "stable");

// Validation.
const user = { role: "user", content: "aaj ki sales?" };
assert.equal(agent.validateMessages([user]), null);
assert.match(agent.validateMessages([]), /non-empty/);
assert.match(agent.validateMessages([{ role: "assistant", content: "x" }]), /first message/);
assert.match(agent.validateMessages([user, { role: "system", content: "x" }]), /role/);
assert.match(agent.validateMessages([user, { role: "assistant", content: [{ type: "tool_use", name: "bash", id: "1", input: {} }] }]), /Unknown tool/);
assert.equal(agent.validateMessages([user, { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "tool_use", name: "run_sql", id: "1", input: { sql: "select 1" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "[]" }] }]), null);
assert.match(agent.validateMessages(Array.from({ length: 161 }, () => user)), /too long/);

// Without a key the endpoint answers 503 AI_NOT_CONFIGURED (no streaming started).
const res = { code: 0, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
(async () => {
await agent.streamTurn({ body: { messages: [user] } }, res);
assert.equal(res.code, 503);
assert.equal(res.body.code, "AI_NOT_CONFIGURED");

// Typed SDK errors map to friendly codes.
const Anthropic = require("@anthropic-ai/sdk");
const A = Anthropic.default || Anthropic;
assert.equal(agent.errorPayload(new A.APIConnectionError({ message: "x" })).code, "AI_UNREACHABLE");
assert.equal(agent.errorPayload(new Error("x")).code, "AI_FAILED");
console.log("assistant agent tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
