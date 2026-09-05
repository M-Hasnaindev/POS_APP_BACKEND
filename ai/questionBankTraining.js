const bank = require("./questionBank.generated.json");
const { tokenizeBusiness, conceptsForText, normalizeBasic } = require("./posLanguage");

const STOP = new Set([
  "the", "a", "an", "and", "or", "to", "of", "for", "in", "on", "at", "by", "with", "from", "show", "tell", "what", "which", "how",
  "me", "my", "this", "that", "is", "are", "was", "were", "do", "does", "did", "can", "please", "all", "today", "yesterday",
  "ki", "ka", "ke", "ko", "se", "tak", "mein", "main", "par", "aur", "batao", "dikhao", "karo", "wali", "wala", "hain", "hai", "tha", "thi",
]);

const CATEGORY_CONCEPTS = Object.freeze({
  "Sales & Returns": ["sales", "return", "salesman", "branch", "stockroom", "product", "quantity", "amount", "profit", "brand", "category"],
  "Stock & Inventory": ["stock", "stockroom", "branch", "product", "opening_stock", "transfer", "adjustment", "stock_take"],
  "Purchases & Purchase Returns": ["purchase", "purchase_return", "supplier", "product", "branch", "stockroom", "amount", "quantity"],
  "Transfers, Stock Take, Adjustments & Opening": ["transfer", "stock_take", "adjustment", "opening_stock", "stock", "branch", "stockroom", "product"],
  "Product, Barcode & Merchandise": ["product", "brand", "category", "color", "size", "season", "supplier"],
  "Payments, Accounts, Customers & Suppliers": ["payment", "account", "customer", "supplier", "bills"],
  "Branches, Stockrooms, Employees & Counters": ["branch", "stockroom", "salesman", "counter"],
  "Targets, Incentives & Management Hierarchy": ["target", "incentive", "hierarchy", "salesman", "branch", "category"],
  "Discount Policies": ["discount", "product", "branch"],
  "AI Analysis, Forecast, Prediction & Cross-Questions": ["forecast", "analysis", "compare", "top", "bottom", "sales", "stock", "purchase"],
  "Schema-Aware, Field-Specific & Tricky": ["sales", "stock", "purchase", "transfer", "target", "incentive", "discount", "product", "branch", "stockroom"],
});

const entries = bank.questions.map((entry, index) => {
  const tokens = tokenizeBusiness(entry.question).filter((token) => !STOP.has(token));
  return {
    index,
    id: entry.id,
    category: entry.category,
    language: entry.language,
    question: entry.question,
    normalized: normalizeBasic(entry.question),
    tokens,
    concepts: [...conceptsForText(entry.question)],
  };
});

const exactByNormalized = new Map();
const duplicateNormalized = new Set();
for (const entry of entries) {
  // Centralization deliberately masks tenant entities (BRANCH_X, CODE_X, etc.),
  // so two source examples can become the same generic template. A duplicate
  // generic template must NOT be treated as one exact semantic fact; let the
  // intent vote decide instead.
  if (exactByNormalized.has(entry.normalized)) duplicateNormalized.add(entry.normalized);
  else exactByNormalized.set(entry.normalized, entry);
}
for (const normalized of duplicateNormalized) exactByNormalized.delete(normalized);

function findExactTrainingQuestion(question) {
  const entry = exactByNormalized.get(normalizeBasic(question));
  if (!entry) return null;
  return { id: entry.id, category: entry.category, language: entry.language, question: entry.question };
}

const inverted = new Map();
for (const entry of entries) {
  for (const token of entry.tokens) {
    if (STOP.has(token)) continue;
    let posting = inverted.get(token);
    if (!posting) { posting = []; inverted.set(token, posting); }
    posting.push(entry.index);
  }
}

const cache = new Map();

function categoryBoost(category, userConcepts) {
  const expected = CATEGORY_CONCEPTS[category] || [];
  let score = 0;
  for (const concept of userConcepts) if (expected.includes(concept)) score += 3;
  return score;
}

function scoreEntry(entry, userTokens, userConcepts, normalizedQuestion) {
  const entryTokenSet = new Set(entry.tokens);
  let overlap = 0;
  let exactNumber = 0;
  for (const token of userTokens) {
    if (!entryTokenSet.has(token)) continue;
    if (/^\d{5,18}$/.test(token)) exactNumber += 0; // tenant-specific codes are entities, never training facts
    else if (token.startsWith("concept_")) overlap += 7;
    else if (token.length >= 7) overlap += 4;
    else if (token.length >= 4) overlap += 2.5;
    else overlap += 1;
  }
  const entryConcepts = new Set(entry.concepts);
  let conceptOverlap = 0;
  for (const concept of userConcepts) if (entryConcepts.has(concept)) conceptOverlap += 7;
  const phraseBonus = entry.normalized === normalizedQuestion
    ? 120
    : normalizedQuestion.length >= 10 && entry.normalized.includes(normalizedQuestion)
      ? 24
      : 0;
  const coverage = userTokens.length ? (userTokens.filter((token) => entryTokenSet.has(token)).length / userTokens.length) * 8 : 0;
  return overlap + exactNumber + conceptOverlap + phraseBonus + coverage + categoryBoost(entry.category, userConcepts);
}

function retrieveTrainingExamples(question, limit = 8) {
  const normalizedQuestion = normalizeBasic(question);
  const key = `${normalizedQuestion}|${limit}`;
  if (cache.has(key)) return cache.get(key);
  const exact = exactByNormalized.get(normalizedQuestion);
  if (exact) {
    const result = [{ id:exact.id, category:exact.category, language:exact.language, question:exact.question, score:999 }];
    if (cache.size > 500) cache.clear();
    cache.set(key, result);
    return result;
  }
  const userTokens = tokenizeBusiness(question).filter((token) => !STOP.has(token));
  const userConcepts = [...conceptsForText(question)];
  const candidates = new Set();
  for (const token of userTokens) {
    const posting = inverted.get(token);
    if (posting) for (const index of posting) candidates.add(index);
  }
  // Synonym-only/very short queries can still find examples via concept postings.
  if (candidates.size < 40) {
    for (const concept of userConcepts) {
      const posting = inverted.get(`concept_${concept}`);
      if (posting) for (const index of posting) candidates.add(index);
    }
  }
  // If wording is extremely novel, score the complete 10k bank. This is a rare
  // fallback and still inexpensive compared with a remote LLM call.
  const pool = candidates.size ? [...candidates].map((index) => entries[index]) : entries;
  const ranked = pool
    .map((entry) => ({ entry, score: scoreEntry(entry, userTokens, userConcepts, normalizedQuestion) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id - b.entry.id)
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 16)))
    .map(({ entry, score }) => ({
      id: entry.id,
      category: entry.category,
      language: entry.language,
      question: entry.question,
      score: Math.round(score * 100) / 100,
    }));
  if (cache.size > 500) cache.clear();
  cache.set(key, ranked);
  return ranked;
}

function getQuestionBankTrainingPrompt(question, limit = 8) {
  const examples = retrieveTrainingExamples(question, limit);
  if (!examples.length) return "No close training example was found; use schema/business rules and ask a focused clarification instead of guessing.";
  return [
    `CENTRAL 10,000-QUESTION INTENT BANK — ${examples.length} closest templates for this turn (templates teach wording/intent only; ALL names/codes/amounts must come from the current authenticated tenant):`,
    ...examples.map((item) => `- [Q${String(item.id).padStart(5, "0")} | ${item.category}] ${item.question}`),
  ].join("\n");
}

function getQuestionBankStats() {
  return {
    questionCount: bank.questionCount,
    categories: bank.categoryCounts,
    languages: bank.languageCounts,
    sources: bank.sourceWorkbooks,
    version: bank.version,
    centralized: Boolean(bank.centralized),
    trainingPolicy: bank.trainingPolicy || null,
  };
}

module.exports = {
  retrieveTrainingExamples,
  findExactTrainingQuestion,
  getQuestionBankTrainingPrompt,
  getQuestionBankStats,
};
