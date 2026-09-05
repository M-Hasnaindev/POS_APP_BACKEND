const fs = require("fs");
const path = require("path");
const bank = require("../ai/questionBank.generated.json");
const { parseSurfaceIntent, verifiedRouteForIntent, intentSignature } = require("../ai/intentParser");

const rows = bank.questions.map((item) => {
  const intent = parseSurfaceIntent(item.question);
  const route = verifiedRouteForIntent(intent);
  return {
    id: item.id,
    domain: intent.domain,
    dimension: intent.dimension,
    metrics: intent.metrics,
    operation: intent.operation,
    special: intent.special,
    signature: intentSignature(intent),
    route,
  };
});

const counts = {};
for (const row of rows) {
  const key = row.route?.kind || "unknown";
  counts[key] = (counts[key] || 0) + 1;
}
const payload = {
  version: "2026-09-05-semantic-guard-v1",
  sourceQuestionBankVersion: bank.version,
  questionCount: rows.length,
  routeKindCounts: counts,
  rows,
};
const target = path.join(__dirname, "..", "ai", "questionIntentIndex.generated.json");
fs.writeFileSync(target, JSON.stringify(payload));
console.log(`Wrote ${rows.length} intent annotations -> ${target}`);
console.log(counts);
