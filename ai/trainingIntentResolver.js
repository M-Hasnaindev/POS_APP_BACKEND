const { conceptsForText, canonicalizeForRouting, normalizeBasic } = require("./posLanguage");
const { parseSurfaceIntent } = require("./intentParser");
const {
  retrieveTrainingExamples,
  findExactTrainingQuestion,
} = require("./questionBankTraining");

const CATEGORY_DOMAIN = Object.freeze({
  "Sales & Returns": "sales",
  "Stock & Inventory": "stock",
  "Purchases & Purchase Returns": "purchase",
  "Transfers, Stock Take, Adjustments & Opening": "inventory-movement",
  "Product, Barcode & Merchandise": "product",
  "Payments, Accounts, Customers & Suppliers": "accounts-payment",
  "Branches, Stockrooms, Employees & Counters": "masterdata",
  "Targets, Incentives & Management Hierarchy": "target-incentive",
  "Discount Policies": "discount",
  "AI Analysis, Forecast, Prediction & Cross-Questions": "ai-analysis",
  "Schema-Aware, Field-Specific & Tricky": "schema",
});

const HUMAN_DOMAIN = Object.freeze({
  sales: "sales / returns",
  stock: "stock / inventory",
  purchase: "purchase / purchase return",
  "inventory-movement": "transfer / stock movement",
  product: "product / barcode",
  "accounts-payment": "payments / accounts",
  masterdata: "branch / store / employee master data",
  "target-incentive": "targets / incentives / hierarchy",
  discount: "discount policy",
  "ai-analysis": "analysis / forecast",
  schema: "database field / schema meaning",
});

function explicitDomainForQuestion(question) {
  const surface = parseSurfaceIntent(question);
  const domain = surface.domain;
  if (!domain) return null;
  if (domain === "schema") return "schema";
  if (domain === "target-incentive") return "target-incentive";
  if (domain === "discount-policy") return "discount";
  if (["transfer","stock-take","adjustment","opening-stock"].includes(domain)) return "inventory-movement";
  if (["purchase","purchase-return"].includes(domain)) return "purchase";
  if (["payment","accounts"].includes(domain)) return "accounts-payment";
  if (["sales","sales-tax"].includes(domain)) return "sales";
  if (domain === "stock") return "stock";
  if (domain === "product") return "product";
  if (domain === "masterdata") return "masterdata";
  return null;
}

function routeDomainForReportCode(code) {
  const value = String(code || "").toUpperCase();
  if (!value) return null;
  if (value === "RPT_02_032_CASH_CARD_CREDIT_SALES") return "accounts-payment";
  if (value.startsWith("RPT_02_")) return "sales";
  if (value.startsWith("RPT_03_")) return "stock";
  if (value.startsWith("RPT_05_")) return "purchase";
  if (value.startsWith("RPT_06_")) return "inventory-movement";
  if (value.startsWith("RPT_07_")) return "product";
  if (value.startsWith("RPT_16_")) return "discount";
  if (value.startsWith("RPT_25_")) return "target-incentive";
  if (value.startsWith("RPT_26_")) return "sales";
  return null;
}

function underlyingDomainFromExample(example) {
  const categoryDomain = CATEGORY_DOMAIN[example.category] || null;
  if (categoryDomain !== "ai-analysis" && categoryDomain !== "schema") return categoryDomain;
  return explicitDomainForQuestion(example.question) || categoryDomain;
}

function confidenceBand(value) {
  if (value >= 0.82) return "high";
  if (value >= 0.62) return "medium";
  return "low";
}

function resolveTrainingIntent(question, limit = 9) {
  const normalized = normalizeBasic(question);
  const exact = findExactTrainingQuestion(question);
  const examples = retrieveTrainingExamples(question, Math.max(5, Math.min(Number(limit) || 9, 12)));
  const explicitDomain = explicitDomainForQuestion(question);

  const categoryWeights = new Map();
  const domainWeights = new Map();
  let totalWeight = 0;
  for (let index = 0; index < examples.length; index += 1) {
    const item = examples[index];
    // Rank discount keeps the top semantic matches dominant while still allowing
    // several synonymous examples to vote together.
    const rankWeight = Math.max(0.35, 1 - index * 0.075);
    const scoreWeight = Math.max(1, Number(item.score || 0));
    const weight = rankWeight * scoreWeight;
    totalWeight += weight;
    categoryWeights.set(item.category, (categoryWeights.get(item.category) || 0) + weight);
    const domain = underlyingDomainFromExample(item);
    if (domain) domainWeights.set(domain, (domainWeights.get(domain) || 0) + weight);
  }

  const rankedDomains = [...domainWeights.entries()].sort((a, b) => b[1] - a[1]);
  const dominantDomain = rankedDomains[0]?.[0] || explicitDomain || null;
  const dominantWeight = rankedDomains[0]?.[1] || 0;
  const secondWeight = rankedDomains[1]?.[1] || 0;
  const domainShare = totalWeight > 0 ? dominantWeight / totalWeight : 0;
  const gapShare = dominantWeight > 0 ? Math.max(0, (dominantWeight - secondWeight) / dominantWeight) : 0;
  const topScore = Number(examples[0]?.score || 0);
  const secondScore = Number(examples[1]?.score || 0);
  const scoreGap = topScore > 0 ? Math.max(0, (topScore - secondScore) / topScore) : 0;

  let confidence = 0;
  if (exact) confidence = 1;
  else {
    confidence = Math.min(0.96,
      (explicitDomain ? 0.34 : 0)
      + Math.min(0.34, domainShare * 0.42)
      + Math.min(0.18, gapShare * 0.24)
      + Math.min(0.10, scoreGap * 0.2),
    );
    // Explicit business nouns are a very strong signal even when wording is novel.
    if (explicitDomain && examples.length) confidence = Math.max(confidence, 0.72);
  }

  const topDomains = rankedDomains.slice(0, 3).map(([domain, weight]) => ({
    domain,
    label: HUMAN_DOMAIN[domain] || domain,
    share: totalWeight ? weight / totalWeight : 0,
  }));

  const surfaceIntent = parseSurfaceIntent(question);
  const conflict = Boolean(explicitDomain && dominantDomain && explicitDomain !== dominantDomain
    && dominantDomain !== "ai-analysis" && dominantDomain !== "schema"
    && domainShare >= 0.58 && Number(surfaceIntent.explicitSignals || 0) <= 1);
  const ambiguous = !exact && (
    conflict
    || (!explicitDomain && confidence < 0.58)
    || (!explicitDomain && rankedDomains.length > 1 && Math.abs((rankedDomains[0]?.[1] || 0) - (rankedDomains[1]?.[1] || 0)) <= Math.max(3, totalWeight * 0.12))
  );

  return {
    normalized,
    exact: exact ? { id: exact.id, category: exact.category, language: exact.language, question: exact.question } : null,
    examples,
    explicitDomain,
    dominantDomain,
    topDomains,
    confidence: Math.round(confidence * 1000) / 1000,
    confidenceBand: confidenceBand(confidence),
    ambiguous,
    conflict,
  };
}

function verifyReportRoute(question, reportCode, understanding = null) {
  const info = understanding || resolveTrainingIntent(question);
  const routeDomain = routeDomainForReportCode(reportCode);
  if (!routeDomain) return { ok: true, routeDomain, reason: "unclassified-report" };

  const expected = info.explicitDomain || (info.confidence >= 0.68 ? info.dominantDomain : null);
  if (!expected || expected === "ai-analysis" || expected === "schema" || expected === "masterdata") {
    return { ok: true, routeDomain, reason: "no-conflicting-domain" };
  }

  // Product questions can legitimately ask product-wise sales/stock/purchase.
  if (expected === "product" && ["sales", "stock", "purchase"].includes(routeDomain)) {
    const concepts = conceptsForText(question);
    if (concepts.has("sales") || concepts.has("stock") || concepts.has("purchase")) return { ok: true, routeDomain, reason: "product-dimension" };
  }
  // Master-data nouns such as branch/store/salesman often act as dimensions.
  if (expected === "masterdata" && ["sales", "stock", "purchase", "inventory-movement"].includes(routeDomain)) return { ok: true, routeDomain, reason: "master-dimension" };

  if (expected !== routeDomain) {
    return {
      ok: false,
      routeDomain,
      expectedDomain: expected,
      reason: `training-domain-mismatch:${expected}->${routeDomain}`,
    };
  }
  return { ok: true, routeDomain, reason: "matched" };
}

function groundingMetadata(understanding, extra = {}) {
  const info = understanding || {};
  return {
    trainingQuestionCount: 10000,
    trainingConfidence: info.confidence || 0,
    trainingConfidenceBand: info.confidenceBand || "low",
    exactTrainingMatch: Boolean(info.exact),
    matchedQuestionIds: (info.examples || []).slice(0, 5).map((item) => item.id),
    matchedCategories: [...new Set((info.examples || []).slice(0, 5).map((item) => item.category))],
    interpretedDomain: info.explicitDomain || info.dominantDomain || null,
    ambiguityGuard: Boolean(info.ambiguous || info.conflict),
    ...extra,
  };
}

module.exports = {
  CATEGORY_DOMAIN,
  HUMAN_DOMAIN,
  explicitDomainForQuestion,
  routeDomainForReportCode,
  resolveTrainingIntent,
  verifyReportRoute,
  groundingMetadata,
};
