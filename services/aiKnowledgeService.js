const knowledge = require("../ai/trainingKnowledge.generated.json");
const { dashboardCompatibleRules } = require("../ai/conversationTraining");
const { tokenizeBusiness } = require("../ai/posLanguage");

const ALWAYS_RELEVANT = new Set(["branchfile", "stockroom", "barcodeview"]);

function tokenize(value) {
  return new Set(tokenizeBusiness(value).filter((token) => token.length >= 3));
}

function scoreTokens(left, right) {
  let score = 0;
  for (const token of left) if (right.has(token)) score += 1;
  return score;
}

function normalizedTables() {
  return Object.entries({
    ...(knowledge.tables || {}),
    ...(knowledge.undocumentedLiveTables || {}),
  }).map(([name, table]) => ({ name, ...table }));
}

function getKnowledgeContext(question, tableHints = []) {
  const questionTokens = tokenize(question);
  const hints = new Set(tableHints.map((name) => String(name).split(".").pop().toLowerCase()));
  const tables = normalizedTables()
    .map((table) => {
      const searchable = tokenize([
        table.name, table.businessArea, table.purpose, table.mainJoin,
        table.stockEffect, table.importantRule,
        ...(table.fields || []).map((field) => `${field.name} ${field.meaning} ${field.rule || ""}`),
      ].join(" "));
      const hinted = hints.has(table.name.toLowerCase()) ? 50 : 0;
      const reference = ALWAYS_RELEVANT.has(table.name.toLowerCase()) ? 1 : 0;
      return { table, score: hinted + reference + scoreTokens(questionTokens, searchable) };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 10)
    .map(({ table }) => ({
      name: table.name,
      purpose: table.purpose,
      relationship: table.mainJoin,
      stockEffect: table.stockEffect,
      rule: table.importantRule,
      fields: (table.fields || []).slice(0, 30),
    }));

  const conflictingGenericSalesRule = (rule) => {
    const topic = String(rule?.Topic || rule?.topic || "").toLowerCase();
    const text = String(rule?.Rule || rule?.rule || "").toLowerCase();
    return topic === "sales" && (text.includes("billstatus='p'") || text.includes("protect against duplicate bills"));
  };
  const businessRules = (knowledge.businessRules || [])
    .filter((rule) => !conflictingGenericSalesRule(rule))
    .map((rule) => ({
      rule,
      score: scoreTokens(questionTokens, tokenize(`${rule.Topic || rule.topic || ""} ${rule.Rule || rule.rule || ""}`)),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8)
    .map((item) => item.rule);
  if (/\b(sale|sales|revenue|bikri|farokht|return|profit|margin)\b/i.test(String(question || ""))) {
    dashboardCompatibleRules.slice(0, 4).forEach((rule) => businessRules.unshift({ Topic: "Mobile Sales Dashboard", Rule: rule }));
  }

  const queryExamples = (knowledge.queryGuide || [])
    .map((entry) => ({
      entry,
      score: scoreTokens(questionTokens, tokenize(`${entry["Example User Question"] || entry.question || ""} ${entry.Intent || entry.intent || ""}`)),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((item) => item.entry);

  return {
    authority: knowledge.sourceRole,
    sourceWorkbook: knowledge.sourceWorkbook,
    documentedTableCount: normalizedTables().length,
    tables,
    businessRules,
    queryExamples,
  };
}

function getDocumentedTableNames() {
  return normalizedTables().map((table) => table.name);
}

module.exports = { getDocumentedTableNames, getKnowledgeContext };
