const fs = require("fs");
const vm = require("vm");
const path = require("path");

const code = fs.readFileSync(path.join(__dirname, "../services/aiService.js"), "utf8");
const sandbox = {
  module: { exports: {} },
  exports: {},
  console,
  Intl,
  Date,
  setTimeout,
  clearTimeout,
  require(name) {
    if (name === "../config/db") return { sql: {}, getPoolForTenant: async () => ({}) };
    if (name === "../config/ai") return { maxRows: 500, maxQuestionLength: 8000, sqlTimeoutMs: 15000 };
    if (name === "../ai/knowledge") return { allowedTables: [], businessRules: [], tablePurposes: {}, selectRelevantTables: () => [], trainingContextForTables: () => "" };
    if (name === "../ai/sqlSafety") return { validateReadOnlySql: (sql) => ({ sql }) };
    if (name === "./ollamaService") return { ollamaChat: async () => ({}) };
    if (name === "./reportService") return {
      normalizeFilters(value = {}) {
        return {
          fromDate: value.fromDate || "2026-09-01",
          toDate: value.toDate || "2026-09-05",
          branches: Array.isArray(value.branches) ? value.branches : [],
          stores: Array.isArray(value.stores) ? value.stores : [],
          barcodes: Array.isArray(value.barcodes) ? value.barcodes : [],
          accounts: Array.isArray(value.accounts) ? value.accounts : [],
          brands: Array.isArray(value.brands) ? value.brands : [],
          categories: Array.isArray(value.categories) ? value.categories : [],
          seasons: [], styles: [], colors: [], sizes: [], designs: [], fabrics: [], departments: [], genders: [], cobrands: [], suppliers: [], subcategories: [], substyles: [], styleclasses: [], styleclass1: [], styleclass2: [], subdepartments: [], fabricclasses: [], colorclasses: [],
        };
      },
    };
    if (name === "./accountingReportService") return {};
    if (name === "./aiDatabaseService") return { getDatabaseCatalog: async () => ({ tables:[] }), compactSchema: () => "" };
    if (name === "../ai/conversationTraining") return { getConversationTrainingPrompt: () => "" };
    if (name === "../ai/posLanguage") return require("../ai/posLanguage");
    if (name === "../ai/questionBankTraining") return { getQuestionBankTrainingPrompt: () => "" };
    if (name === "../ai/trainingIntentResolver") return require("../ai/trainingIntentResolver");
    if (name === "../ai/schemaTrainingAnswer") return { answerSchemaQuestion: () => null, isSchemaKnowledgeQuestion: () => false };
    if (name === "../ai/trainingSemanticRouter") return require("../ai/trainingSemanticRouter");
    throw new Error(`Unexpected require: ${name}`);
  },
};
vm.runInNewContext(code, sandbox, { filename: "aiService.js" });
const ai = sandbox.module.exports;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(ai.forecastIntent("next 7 days sales forecast") === "sales", "English sales forecast intent failed");
assert(ai.forecastIntent("اگلے 7 دن کی سیلز پیش گوئی") === "sales", "Urdu sales forecast intent failed");
assert(ai.forecastWindow("next 7 days sales forecast")?.days === 7, "English 7-day horizon failed");
assert(ai.forecastWindow("اگلے 30 دن کی سیلز پیش گوئی")?.days === 30, "Urdu 30-day horizon failed");
assert(ai.businessAnalysisIntent("sales analyze karo") === true, "Business analysis intent failed");
assert(ai.chooseVerifiedAnalysisReport("sales analyze karo") === "RPT_02_001_SALES_SUMMARY", "Verified sales analysis routing failed");
assert(ai.chooseVerifiedAnalysisReport("branch wise sales kyun down hain") === "RPT_02_005_BRANCH_WISE_SALES", "Verified branch analysis routing failed");

const follow = ai.resolveFollowUpQuestion("branch wise?", [
  { role: "user", content: "aaj ki sales batao" },
  { role: "assistant", content: "..." },
]);
assert(/aaj ki sales batao/i.test(follow) && /branch wise/i.test(follow), "Roman follow-up context failed");

const urduFollow = ai.resolveFollowUpQuestion("برانچ وائز؟", [
  { role: "user", content: "آج کی سیلز بتائیں" },
]);
assert(/آج کی سیلز/.test(urduFollow) && /برانچ وائز/.test(urduFollow), "Urdu follow-up context failed");


const barcodeFollow = ai.resolveFollowUpQuestion("123456", [
  { role: "user", content: "ye stock kab khatam hoga?" },
  { role: "assistant", content: "Kaunsa barcode use karun?" },
]);
assert(/stock kab khatam/i.test(barcodeFollow) && /123456/.test(barcodeFollow), "Barcode clarification follow-up failed");

const report = {
  title: "Sales Summary",
  filters: { fromDate: "2026-09-04", toDate: "2026-09-04" },
  kpis: [
    { label: "Net Sales", format: "currency", value: 100000 },
    { label: "Net Quantity", format: "number", value: 250 },
    { label: "Gross Profit", format: "currency", value: 30000 },
    { label: "Bills", format: "number", value: 40 },
  ],
  rows: [],
};
const qty = ai.naturalFastNarrative(report, "aaj kitni quantity sale hui?", "roman").summary;
assert(/250/.test(qty), "Quantity answer missing quantity");
assert(!/100,000/.test(qty) && !/30,000/.test(qty) && !/40/.test(qty), "Quantity answer leaked unrelated KPIs");

const amount = ai.naturalFastNarrative(report, "aaj ki sale kitni hui?", "roman").summary;
assert(/100,000/.test(amount), "Sales amount answer missing amount");
assert(!/250/.test(amount) && !/30,000/.test(amount) && !/40/.test(amount), "Sales amount answer leaked unrelated KPIs");

const urduQty = ai.naturalFastNarrative(report, "آج کتنی مقدار فروخت ہوئی؟", "urdu").summary;
assert(/250/.test(urduQty), "Urdu quantity answer missing quantity");
assert(!/100,000/.test(urduQty) && !/30,000/.test(urduQty) && !/40/.test(urduQty), "Urdu quantity answer leaked unrelated KPIs");

const stockValueClarify = ai.clarificationForQuestion("stock value batao", "stock value batao", [], {}, "roman");
assert(stockValueClarify && /cost\/purchase/i.test(stockValueClarify.answer), "Stock value basis clarification failed");

const clarify = ai.clarificationForQuestion("sales forecast batao", "sales forecast batao", [], {}, "roman");
assert(clarify && /period/i.test(clarify.answer) && clarify.options.length === 3, "Forecast horizon clarification failed");

const urduClarify = ai.clarificationForQuestion("سیلز پیش گوئی بتائیں", "سیلز پیش گوئی بتائیں", [], {}, "urdu");
assert(urduClarify && /مدت/.test(urduClarify.answer), "Urdu forecast clarification failed");



const rememberedFilters = ai.inheritConversationFilters(
  "branch wise?",
  { fromDate: "2026-09-05", toDate: "2026-09-05", branches: [] },
  { filters: { fromDate: "2026-09-01", toDate: "2026-09-04", branches: ["001"] } },
);
assert(rememberedFilters.fromDate === "2026-09-01" && rememberedFilters.toDate === "2026-09-04", "Follow-up did not inherit prior date scope");
assert(rememberedFilters.branches[0] === "001", "Follow-up did not inherit prior branch scope");

const memory = ai.buildConversationMemory({
  previous: null,
  originalQuestion: "is month sales batao",
  resolvedQuestion: "is month sales batao",
  semanticUnderstanding: { intent: { domain: "sales", dimension: "summary" } },
  filters: { fromDate: "2026-09-01", toDate: "2026-09-05", branches: ["001"] },
  result: {
    mode: "report",
    answer: "Net Sales: Rs 100,000",
    scope: "2026-09-01 to 2026-09-05 · Branch: 001",
    keyPoints: ["Sale Amount: Rs 110,000", "Return Amount: Rs 10,000"],
    metrics: [{ key: "netSales", label: "Net Sales", format: "currency", value: 100000 }],
  },
  extra: { route: "RPT_02_001_SALES_SUMMARY" },
});
assert(memory.version === 3, "Structured memory version was not upgraded");
assert(memory.turns.length === 1 && /100,000/.test(memory.turns[0].answerSummary), "Structured memory did not preserve prior answer context");
assert(memory.turns[0].metrics[0].value === 100000, "Structured memory did not preserve prior metric context");

console.log("Assistant conversation logic tests passed");
