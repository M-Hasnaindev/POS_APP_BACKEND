const assert = require("node:assert/strict");
const dotenv = require("dotenv");
const { dotenvValue } = require("../services/adminEnvironment");
const values = [
  "plain",
  "# hash",
  "  spaces  ",
  "line1\nline2",
  "C:\\new\\reports",
  JSON.stringify({ name: "service", key: "a\nb", nested: { enabled: true } }),
  JSON.stringify({ name: "user's key", line: "hello\nworld" }),
  'a`b"c',
  "",
];
for (const value of values)
  assert.equal(
    dotenv.parse("VALUE=" + dotenvValue(value) + "\n").VALUE,
    value,
    "dotenv export must roundtrip",
  );
assert.throws(() => dotenvValue("all'\"`\nquotes"), /cannot be represented/);
console.log(
  "Environment export roundtrip tests passed (synthetic values only).",
);
