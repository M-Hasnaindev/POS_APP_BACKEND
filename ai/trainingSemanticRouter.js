const intentIndex = require("./questionIntentIndex.generated.json");
const { retrieveTrainingExamples, findExactTrainingQuestion } = require("./questionBankTraining");
const { parseSurfaceIntent, verifiedRouteForIntent, intentSignature } = require("./intentParser");

const byId = new Map(intentIndex.rows.map((row) => [Number(row.id), row]));

function weightedVote(items, selector) {
  const map = new Map();
  let total = 0;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const key = selector(item);
    if (key == null || key === "") continue;
    const rawScore = Math.max(1, Number(item.score || 1));
    const rankDecay = Math.max(0.35, 1 - index * 0.07);
    const weight = rawScore * rankDecay;
    total += weight;
    map.set(key, (map.get(key) || 0) + weight);
  }
  const ranked = [...map.entries()].sort((a, b) => b[1] - a[1]);
  return {
    top: ranked[0]?.[0] ?? null,
    share: total ? (ranked[0]?.[1] || 0) / total : 0,
    second: ranked[1]?.[0] ?? null,
    secondShare: total ? (ranked[1]?.[1] || 0) / total : 0,
    ranked,
  };
}

function annotatedMatches(question, limit = 12) {
  return retrieveTrainingExamples(question, limit).map((example) => ({
    ...example,
    annotation: byId.get(Number(example.id)) || null,
  }));
}

function routeKey(route) {
  if (!route) return null;
  if (route.kind === "report") return `report:${route.code}`;
  if (route.kind === "direct-engine") return `engine:${route.engine}:${route.dimension || "-"}`;
  return `${route.kind}:${route.reason || "-"}`;
}

function parseRouteKey(key) {
  if (!key) return null;
  if (key.startsWith("report:")) return { kind: "report", code: key.slice(7), reason: "training-consensus" };
  if (key.startsWith("engine:")) {
    const [, engine, dimension] = key.split(":");
    return { kind: "direct-engine", engine, dimension: dimension === "-" ? null : dimension, reason: "training-consensus" };
  }
  return null;
}

function confidenceBand(value) {
  if (value >= 0.84) return "high";
  if (value >= 0.68) return "medium";
  return "low";
}

function compatibleDimension(explicit, voted) {
  if (!explicit || !voted) return true;
  if (explicit === voted) return true;
  // Product and design are often used interchangeably by users, but not size/color etc.
  if ([explicit, voted].every((x) => ["barcode", "design"].includes(x))) return true;
  return false;
}

function resolveSemanticTrainingIntent(question, limit = 12) {
  const explicit = parseSurfaceIntent(question);
  const exact = findExactTrainingQuestion(question);
  if (exact) {
    const annotation = byId.get(Number(exact.id));
    const route = annotation?.route || verifiedRouteForIntent(explicit);
    const intrinsicAmbiguity = Boolean(
      explicit.domain === "masterdata"
      && (explicit.metrics || []).some((metric) => ["amount","quantity","profit","margin","discount","bills"].includes(metric))
    );
    return {
      explicit,
      intent: explicit,
      signature: annotation?.signature || intentSignature(explicit),
      route,
      confidence: 1,
      confidenceBand: "high",
      unsafeAmbiguity: intrinsicAmbiguity,
      conflicts: { domainConflict:false, dimensionConflict:false, routeConflict:false, intrinsicAmbiguity },
      votes: {
        domain: { top:annotation?.domain || explicit.domain || null, share:1, second:null, secondShare:0, ranked:[] },
        dimension: { top:annotation?.dimension || explicit.dimension || null, share:1, second:null, secondShare:0, ranked:[] },
        operation: { top:annotation?.operation || explicit.operation || null, share:1, second:null, secondShare:0, ranked:[] },
        special: { top:annotation?.special || explicit.special || null, share:1, second:null, secondShare:0, ranked:[] },
        route: { top:routeKey(route), share:1, second:null, secondShare:0, ranked:[] },
      },
      exact: { id:exact.id, category:exact.category, question:exact.question },
      matches: [{ ...exact, score:999, annotation }],
    };
  }
  const matches = annotatedMatches(question, Math.max(8, Math.min(Number(limit) || 12, 16)));
  const annotated = matches.filter((item) => item.annotation);

  const domainVote = weightedVote(annotated, (item) => item.annotation.domain);
  const dimensionVote = weightedVote(annotated, (item) => item.annotation.dimension);
  const operationVote = weightedVote(annotated, (item) => item.annotation.operation);
  const specialVote = weightedVote(annotated, (item) => item.annotation.special);
  const routeVote = weightedVote(annotated.filter((item) => ["report", "direct-engine"].includes(item.annotation.route?.kind)), (item) => routeKey(item.annotation.route));

  const explicitRoute = verifiedRouteForIntent(explicit);
  const exactAnnotation = exact ? byId.get(Number(exact.id)) : null;
  const exactRoute = exactAnnotation?.route || null;

  let finalIntent = { ...explicit };
  // If the current wording carries no explicit business noun, inherit a strong
  // corpus vote instead of guessing with the LLM. Follow-up context is already
  // expanded before this function is called, so this mainly handles synonyms.
  if (!finalIntent.domain && domainVote.share >= 0.72) finalIntent.domain = domainVote.top;
  if (!finalIntent.dimension && finalIntent.asksBreakdown && !explicit.special && dimensionVote.share >= 0.74) finalIntent.dimension = dimensionVote.top;
  if ((!finalIntent.special || finalIntent.special === "advanced-stock") && specialVote.share >= 0.78
      && (!explicit.domain || explicit.domain === domainVote.top)) finalIntent.special = specialVote.top;
  if (finalIntent.operation === "summary" && operationVote.share >= 0.76 && operationVote.top) finalIntent.operation = operationVote.top;

  const derivedRoute = verifiedRouteForIntent(finalIntent);
  let selectedRoute = exactRoute || derivedRoute;

  // Training consensus may provide a deterministic route for wording whose
  // explicit parser only recognized a broad domain. It is never allowed to
  // override an explicit conflicting domain/dimension.
  const consensusRoute = routeVote.share >= 0.76 ? parseRouteKey(routeVote.top) : null;
  if (!exactRoute && consensusRoute && ["unknown", "planner"].includes(selectedRoute.kind)
      && !explicit.special && explicit.explicitSignals <= 1) {
    if (!explicit.domain || explicit.domain === domainVote.top) {
      if (!explicit.dimension || compatibleDimension(explicit.dimension, dimensionVote.top)) selectedRoute = consensusRoute;
    }
  }

  const domainConflict = Boolean(explicit.domain && domainVote.top && domainVote.share >= 0.58 && explicit.domain !== domainVote.top
    && explicit.explicitSignals <= 1);
  // A literal 'branch wise', 'salesman wise', etc. in the current question is
  // stronger than neighbour examples that happen to use another dimension.
  const dimensionConflict = Boolean(!explicit.dimension && finalIntent.dimension && dimensionVote.top
    && dimensionVote.share < 0.56);
  const routeConflict = Boolean(
    selectedRoute?.kind === "report"
    && consensusRoute?.kind === "report"
    && routeVote.share >= 0.60
    && selectedRoute.code !== consensusRoute.code
    && explicit.explicitSignals <= 1,
  );

  const topScore = Number(matches[0]?.score || 0);
  const secondScore = Number(matches[1]?.score || 0);
  const lexicalGap = topScore > 0 ? Math.max(0, (topScore - secondScore) / topScore) : 0;
  let confidence = 0;
  if (exact) confidence = 1;
  else {
    confidence = Math.min(0.97,
      (explicit.domain ? 0.34 : 0)
      + (explicit.dimension ? 0.12 : 0)
      + Math.min(0.26, domainVote.share * 0.32)
      + Math.min(0.14, routeVote.share * 0.18)
      + Math.min(0.11, lexicalGap * 0.25),
    );
    if (explicit.domain && annotated.length >= 3) confidence = Math.max(confidence, 0.70);
  }

  const intrinsicAmbiguity = Boolean(
    finalIntent.domain === "masterdata"
    && (finalIntent.metrics || []).some((metric) => ["amount","quantity","profit","margin","discount","bills"].includes(metric))
  );
  const unsafeAmbiguity = Boolean(
    ((!exact) && (domainConflict || dimensionConflict || routeConflict))
    || intrinsicAmbiguity
    || (!exact && !finalIntent.domain && confidence < 0.68)
    || (!exact && explicit.explicitSignals === 0 && domainVote.share < 0.66),
  );

  // A low-confidence deterministic route is safer as a clarification/planner
  // candidate than as a confident answer. Exact bank matches are always kept.
  if (!exact && confidence < 0.62 && ["report", "direct-engine"].includes(selectedRoute?.kind)) {
    selectedRoute = { kind: "planner", reason: "semantic-confidence-below-route-threshold" };
  }

  return {
    explicit,
    intent: finalIntent,
    signature: intentSignature(finalIntent),
    route: selectedRoute,
    confidence: Math.round(confidence * 1000) / 1000,
    confidenceBand: confidenceBand(confidence),
    unsafeAmbiguity,
    conflicts: { domainConflict, dimensionConflict, routeConflict, intrinsicAmbiguity },
    votes: {
      domain: domainVote,
      dimension: dimensionVote,
      operation: operationVote,
      special: specialVote,
      route: routeVote,
    },
    exact: exact ? { id: exact.id, category: exact.category, question: exact.question } : null,
    matches: matches.slice(0, 8),
  };
}

function semanticGroundingMetadata(info) {
  return {
    semanticIntent: info?.signature || null,
    semanticConfidence: Number(info?.confidence || 0),
    semanticConfidenceBand: info?.confidenceBand || "low",
    semanticRouteKind: info?.route?.kind || null,
    semanticRoute: info?.route?.code || info?.route?.engine || null,
    semanticRouteReason: info?.route?.reason || null,
    trainingRouteAgreement: Math.round(Number(info?.votes?.route?.share || 0) * 1000) / 1000,
    semanticAmbiguityGuard: Boolean(info?.unsafeAmbiguity),
    semanticConflict: Object.values(info?.conflicts || {}).some(Boolean),
  };
}

function getIntentIndexStats() {
  return {
    version: intentIndex.version,
    questionCount: intentIndex.questionCount,
    routeKindCounts: intentIndex.routeKindCounts,
  };
}

module.exports = {
  resolveSemanticTrainingIntent,
  semanticGroundingMetadata,
  getIntentIndexStats,
};
