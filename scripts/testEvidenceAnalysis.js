const assert = require("node:assert/strict");
const { buildEvidenceDigest, groundExplanation } = require("../services/evidenceGrounding");

const evidence = [
  { id: "totals", rows: [{ NetSales: 1000, NetQuantity: 20, GrossProfit: 300, Discount: 50, ReturnQuantity: 2 }] },
  { id: "detail", rows: [{ Label: "Lahore", NetSales: 600 }, { Label: "Karachi", NetSales: 300 }, { Label: "Islamabad", NetSales: 100 }] },
  { id: "secondary", purpose: "Time trend", rows: [{ Label: "2026-09-01", NetSales: 100 }, { Label: "2026-09-02", NetSales: 150 }, { Label: "2026-09-03", NetSales: 250 }] },
];
const plan = { visualization: { queryId: "detail", labelKey: "Label", valueKey: "NetSales" } };
const digest = buildEvidenceDigest(evidence, plan);
assert.equal(digest.leaders[0].label, "Lahore");
assert.equal(digest.leaders[0].sharePercent, 60);
assert.equal(digest.topVsSecond.percentGap, 100);
assert.equal(digest.top3ConcentrationPercent, 100);
assert.equal(digest.trend.direction, "up");
assert.equal(digest.trend.peak.label, "2026-09-03");
assert.equal(digest.secondary.leaders[0].label, "2026-09-03");
assert.equal(digest.ratios.averageSalesValuePerUnit, 50);

const grounded = groundExplanation({
  answer: "Lahore 600 sales ke sath shown mix ka 60% hai aur Karachi se 100% ahead hai.",
  highlights: [], actions: [], suggestions: [], confidence: "high",
}, evidence, "branch wise sales", digest);
assert.match(grounded.answer, /60%/);

const rejected = groundExplanation({
  answer: "Sales guaranteed 99% grow hongi.", highlights: [], actions: [], suggestions: [], confidence: "high",
}, evidence, "branch wise sales", digest);
assert.doesNotMatch(rejected.answer, /99%/);
assert.doesNotMatch(rejected.answer, /Verified result/i);
assert.ok(rejected.highlights.some((value) => /Net Sales 1,000/.test(value)));

console.log("PASS: analytical digest supports grounded shares/gaps and blocks unsupported numeric claims.");
