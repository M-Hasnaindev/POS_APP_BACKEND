const assert = require("assert");
const bank = require("../ai/questionBank.generated.json");
const { retrieveTrainingExamples, getQuestionBankStats } = require("../ai/questionBankTraining");
const { verifyReportRoute } = require("../ai/trainingIntentResolver");

assert.strictEqual(bank.questionCount, 10000, "Expected exactly 10,000 training templates");
assert.strictEqual(bank.centralized, true, "Training bank must be tenant-independent");
assert.strictEqual(Object.keys(bank.categoryCounts || {}).length, 11, "All 11 categories required");
const stats = getQuestionBankStats();
assert.strictEqual(stats.centralized, true);

let retrievalFailures = 0;
for (const item of bank.questions) {
  const matches = retrieveTrainingExamples(item.question, 3);
  if (!matches.length) retrievalFailures += 1;
}
assert.strictEqual(retrievalFailures, 0, `Training templates without retrieval coverage: ${retrievalFailures}`);

const corpus = bank.questions.map((item) => item.question).join("\n").toLowerCase();
for (const value of ["mission road sukkur","station road larkana","mens mission road sukkur","sufyan ali","cotton chinos","00000000007041"]) {
  assert.strictEqual(corpus.includes(value), false, `Sample DB value leaked: ${value}`);
}

assert.strictEqual(verifyReportRoute("godown wise stock batao", "RPT_02_001_SALES_SUMMARY").ok, false);
assert.strictEqual(verifyReportRoute("dukaan wise sales batao", "RPT_02_005_BRANCH_WISE_SALES").ok, true);
assert.strictEqual(verifyReportRoute("supplier wise purchase batao", "RPT_05_003_SUPPLIER_WISE_PURCHASE").ok, true);
assert.strictEqual(verifyReportRoute("active discount policy batao", "RPT_16_016_DISCOUNT_POLICY_COMPLIANCE").ok, true);
console.log("10,000 centralized-template retrieval + route safety audit passed");
