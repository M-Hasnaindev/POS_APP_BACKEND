const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DIMENSIONS } = require("../services/salesStockSemantics");

const file = path.join(__dirname, "..", "ai", "salesStockQuestionCorpus.jsonl");
const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse);
assert.equal(rows.length, 10000, "Corpus must contain exactly 10,000 questions");
assert.equal(new Set(rows.map((row) => row.id)).size, 10000, "Corpus IDs must be unique");
assert.equal(new Set(rows.map((row) => row.question)).size, 10000, "Questions must be unique");
for (const language of ["english", "roman", "urdu"]) assert.ok(rows.filter((row) => row.language === language).length >= 3000, `${language} coverage is too low`);
for (const [dimension, meta] of Object.entries(DIMENSIONS)) for (const domain of meta.domains) {
  assert.ok(rows.some((row) => row.dimension === dimension && row.domain === domain), `Missing ${domain}/${dimension}`);
}
assert.ok(rows.every((row) => row.liveDataRequired === true && row.answerContract.includes("permission-scoped")), "Every answer must be live and scoped");
console.log("PASS: 10,000 unique English, Roman Urdu and Urdu sales/stock questions with full dimension coverage");
