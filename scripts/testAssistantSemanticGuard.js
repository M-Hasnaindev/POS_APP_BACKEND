const assert = require("assert");
const bank = require("../ai/questionBank.generated.json");
const intentIndex = require("../ai/questionIntentIndex.generated.json");
const { resolveSemanticTrainingIntent } = require("../ai/trainingSemanticRouter");
const { conceptsForText } = require("../ai/posLanguage");

assert.strictEqual(bank.questionCount, 10000, "Expected exactly 10,000 questions");
assert.strictEqual(intentIndex.questionCount, 10000, "Expected exactly 10,000 semantic annotations");
assert.strictEqual(intentIndex.rows.length, 10000, "Every training question must have one semantic annotation");
assert.ok(!Object.prototype.hasOwnProperty.call(intentIndex.routeKindCounts, "unknown"), "No training question may remain without a safe route policy");

for (const row of intentIndex.rows) {
  assert.ok(row.route && ["report", "direct-engine", "planner", "schema", "forecast"].includes(row.route.kind), `Question ${row.id} has no safe route policy`);
}

const synonymCases = [
  ["aaj branch wise sale batao", "aaj shop wise sale batao", "RPT_02_005_BRANCH_WISE_SALES"],
  ["aaj branch wise sale batao", "aaj dukaan wise sale batao", "RPT_02_005_BRANCH_WISE_SALES"],
  ["aaj branch wise sale batao", "aaj outlet wise sale batao", "RPT_02_005_BRANCH_WISE_SALES"],
  ["godown wise stock batao", "warehouse wise inventory batao", "RPT_03_004_STORE_WISE_STOCK"],
  ["supplier wise purchase batao", "vendor wise khareed batao", "RPT_05_003_SUPPLIER_WISE_PURCHASE"],
];
for (const [, variant, expectedCode] of synonymCases) {
  const info = resolveSemanticTrainingIntent(variant, 12);
  assert.strictEqual(info.route?.kind, "report", `Expected verified report for: ${variant}`);
  assert.strictEqual(info.route?.code, expectedCode, `Synonym changed intent: ${variant}`);
  assert.strictEqual(info.unsafeAmbiguity, false, `Safe synonym should not be ambiguous: ${variant}`);
}

const typo = resolveSemanticTrainingIntent("brnch wise salse batao", 12);
assert.strictEqual(typo.route?.code, "RPT_02_005_BRANCH_WISE_SALES", "Common typo normalization failed");
assert.ok(conceptsForText("brnch wise salse").has("branch"));
assert.ok(conceptsForText("brnch wise salse").has("sales"));

const ambiguous = resolveSemanticTrainingIntent("shop wise quantity batao", 12);
assert.strictEqual(ambiguous.unsafeAmbiguity, true, "Metric without business subject should trigger cross-question");

const advanced = resolveSemanticTrainingIntent("negative stock dikhao", 12);
assert.strictEqual(advanced.route?.kind, "planner", "Unsupported advanced stock logic must not be silently mapped to generic current stock");

const valuation = resolveSemanticTrainingIntent("stock value at purchase price", 12);
assert.strictEqual(valuation.route?.code, "RPT_03_001_CURRENT_STOCK", "Stock purchase-price valuation must stay in stock domain");

const cashSales = resolveSemanticTrainingIntent("aaj ki cash sales kitni hain", 12);
assert.strictEqual(cashSales.route?.kind, "report", "Cash sales must use the verified payment report");
assert.strictEqual(cashSales.route?.code, "RPT_02_032_CASH_CARD_CREDIT_SALES", "Cash sales must not be routed to total sales");

const cardSales = resolveSemanticTrainingIntent("card wali sale batao", 12);
assert.strictEqual(cardSales.route?.code, "RPT_02_032_CASH_CARD_CREDIT_SALES", "Card-sale wording must stay in payment/tender intent");

const cashPurchase = resolveSemanticTrainingIntent("cash purchase kitni hui", 12);
assert.strictEqual(cashPurchase.route?.code, "RPT_05_001_PURCHASE_REGISTER", "Purchase wording must take precedence over tender wording");

const returns = resolveSemanticTrainingIntent("branch wise sales returns is month", 12);
assert.strictEqual(returns.route?.kind, "direct-engine");
assert.strictEqual(returns.route?.engine, "sales-return");
assert.strictEqual(returns.route?.dimension, "branch");

const supplierPayment = resolveSemanticTrainingIntent("is month kis supplier ko sabse ziyada payment kari h", 12);
assert.strictEqual(supplierPayment.route?.kind, "direct-engine");
assert.strictEqual(supplierPayment.route?.engine, "supplier-payment");
assert.strictEqual(supplierPayment.unsafeAmbiguity, false);

console.log("10,000-question semantic intent + anti-wrong-answer guard passed");
console.log(intentIndex.routeKindCounts);
