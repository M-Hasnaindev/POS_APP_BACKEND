const assert = require("assert");
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { getQuestionBankStats, retrieveTrainingExamples } = require("../ai/questionBankTraining");
const posLanguage = require("../ai/posLanguage");

function loadAssistantPureLogic() {
  const code = fs.readFileSync(path.join(__dirname, "../services/aiService.js"), "utf8");
  const sandbox = {
    module: { exports: {} }, exports: {}, console, Intl, Date, setTimeout, clearTimeout,
    require(name) {
      if (name === "../config/db") return { sql: {}, getPoolForTenant: async () => ({}) };
      if (name === "../config/ai") return { maxRows: 500, maxQuestionLength: 8000, sqlTimeoutMs: 15000, ollamaMaxThinking: false, ollamaComplexThinkLevel: true, ollamaPlannerThinkLevel: false };
      if (name === "../ai/knowledge") return { allowedTables: [], businessRules: [], tablePurposes: {}, selectRelevantTables: () => [], trainingContextForTables: () => "" };
      if (name === "../ai/sqlSafety") return { validateReadOnlySql: (sql) => ({ sql }) };
      if (name === "./ollamaService") return { ollamaChat: async () => ({}) };
      if (name === "./reportService") return {};
      if (name === "./accountingReportService") return {};
      if (name === "./aiDatabaseService") return { getDatabaseCatalog: async () => ({ tables:[] }), compactSchema: () => "" };
      if (name === "../ai/conversationTraining") return { getConversationTrainingPrompt: () => "" };
      if (name === "../ai/posLanguage") return posLanguage;
      if (name === "../ai/questionBankTraining") return { getQuestionBankTrainingPrompt: () => "" };
      if (name === "../ai/trainingIntentResolver") return require("../ai/trainingIntentResolver");
      if (name === "../ai/schemaTrainingAnswer") return { answerSchemaQuestion: () => null, isSchemaKnowledgeQuestion: () => false };
      if (name === "../ai/trainingSemanticRouter") return require("../ai/trainingSemanticRouter");
      throw new Error(`Unexpected require: ${name}`);
    },
  };
  vm.runInNewContext(code, sandbox, { filename: "aiService.js" });
  return sandbox.module.exports;
}

const ai = loadAssistantPureLogic();
const { conceptsForText, canonicalizeForRouting } = posLanguage;
const stats = getQuestionBankStats();
assert.strictEqual(stats.questionCount, 10000, "Question bank must contain exactly 10,000 questions");
assert.strictEqual(Object.keys(stats.categories || {}).length, 11, "Expected 11 training categories");
assert.strictEqual(stats.centralized, true, "Question bank must be tenant-independent");
assert.ok((stats.languages?.english || 0) > 0 && (stats.languages?.roman || 0) > 0, "English + Roman training required");

assert.ok(conceptsForText("dukaan ki aaj sale").has("branch"), "dukaan must map to branch");
assert.ok(conceptsForText("shop wise bikri").has("branch"), "shop must map to branch");
assert.ok(conceptsForText("godown ka stock").has("stockroom"), "godown must map to stockroom");
assert.ok(conceptsForText("maal dene wala").has("supplier"), "maal dene wala must map to supplier");
assert.ok(canonicalizeForRouting("rate kam offer").includes("discount"), "rate kam must map to discount");

const dukaanExamples = retrieveTrainingExamples("aaj kis dukaan ki sale sab se zyada hui?", 5);
assert.ok(dukaanExamples.length >= 3, "Dukaan sales query should retrieve training examples");
assert.ok(dukaanExamples.some((item) => /dukaan|shop|branch|outlet/i.test(item.question)), "Branch synonym example missing");
const forecastExamples = retrieveTrainingExamples("next 30 din ki demand prediction", 5);
assert.ok(forecastExamples.some((item) => /forecast|prediction|demand|aglay 30/i.test(item.question)), "Forecast examples missing");

assert.strictEqual(ai.chooseFastReport("aaj kis dukaan ki sale sab se zyada hui?"), "RPT_02_005_BRANCH_WISE_SALES");
assert.strictEqual(ai.chooseFastReport("shop wise sales dikhao"), "RPT_02_005_BRANCH_WISE_SALES");
assert.strictEqual(ai.chooseFastReport("godown wise stock batao"), "RPT_03_004_STORE_WISE_STOCK");
assert.strictEqual(ai.chooseFastReport("salesman incentive achievement batao"), "RPT_25_002_SALESMAN_INCENTIVE");
assert.strictEqual(ai.chooseFastReport("category incentive performance batao"), "RPT_25_003_CATEGORY_INCENTIVE");
assert.strictEqual(ai.chooseFastReport("is month kis supplier ko sabse ziyada payment kari h"), null, "Supplier payment must not route to POS tender mix");
assert.strictEqual(ai.forecastIntent("next month profit forecast batao"), "complex", "Profit forecast must not silently become sales forecast");
assert.strictEqual(ai.forecastIntent("next 30 days sales forecast"), "sales");
assert.strictEqual(ai.forecastIntent("aglay 30 din quantity demand prediction"), "demand");

const mtd = ai.inferFilters("month to date sales");
assert.ok(/^\d{4}-\d{2}-01$/.test(mtd.fromDate), "MTD should start on first day");
const ytd = ai.inferFilters("year to date sales");
assert.ok(/-01-01$/.test(ytd.fromDate), "YTD should start Jan 1");
const last90 = ai.inferFilters("last 90 days sales");
const diff90 = Math.round((new Date(last90.toDate) - new Date(last90.fromDate)) / 86400000) + 1;
assert.strictEqual(diff90, 90, "Last 90 days parser failed");
const quarter = ai.inferFilters("this quarter sales");
assert.ok(quarter.fromDate <= quarter.toDate, "Quarter parser failed");

console.log("10,000-question Assistant training tests passed");
