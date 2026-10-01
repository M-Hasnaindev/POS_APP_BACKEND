function numbers(text) {
  return [...String(text).matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
    .map((match) => Number(match[0].replaceAll(",", "")))
    .filter(Number.isFinite);
}

function numericEntries(row) {
  return Object.entries(row || {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value));
}

function friendlyLabel(value) {
  return String(value || "Metric")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function rowLabel(row, preferredKey) {
  if (preferredKey && row?.[preferredKey] != null) return String(row[preferredKey]);
  const entry = Object.entries(row || {}).find(([, value]) => typeof value === "string" && value.trim());
  return entry ? String(entry[1]) : "Overall";
}

function preferredMetric(row, preferredKey) {
  if (preferredKey && typeof row?.[preferredKey] === "number") return preferredKey;
  const priority = ["NetSales", "StockValue", "StockQty", "GrossProfit", "SalesValue", "SalesQty", "NetQuantity", "ReturnQuantity", "Discount", "Value", "Quantity"];
  return priority.find((key) => typeof row?.[key] === "number") || numericEntries(row)[0]?.[0] || null;
}

function rounded(value, digits = 2) {
  return Number(Number(value).toFixed(digits));
}

function summarizeRows(rows, visualization = {}) {
  const values = Array.isArray(rows) ? rows : [];
  const metricKey = preferredMetric(values[0], visualization.valueKey);
  const labelKey = visualization.labelKey || null;
  const ranked = metricKey ? values.map((row) => ({ label: rowLabel(row, labelKey), value: Number(row[metricKey]) }))
    .filter((item) => Number.isFinite(item.value)).sort((a, b) => b.value - a.value) : [];
  const positiveTotal = ranked.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const leaders = ranked.slice(0, 5).map((item, index) => ({
    rank: index + 1, label: item.label, value: item.value,
    sharePercent: positiveTotal > 0 ? rounded(Math.max(0, item.value) * 100 / positiveTotal, 1) : null,
  }));
  const top3SharePercent = positiveTotal > 0 ? rounded(ranked.slice(0, 3).reduce((sum, item) => sum + Math.max(0, item.value), 0) * 100 / positiveTotal, 1) : null;
  return { metricKey, ranked, leaders, positiveTotal, top3SharePercent };
}

function analyzeTrend(rows, visualization = {}) {
  const values = Array.isArray(rows) ? rows : [];
  const metricKey = preferredMetric(values[0], visualization.valueKey);
  if (!metricKey || values.length < 2) return null;
  const series = values.map((row) => ({ label: rowLabel(row, visualization.labelKey || "Label"), value: Number(row[metricKey]) }))
    .filter((item) => Number.isFinite(item.value));
  if (series.length < 2 || series.filter((item) => /^\d{4}-\d{2}-\d{2}/.test(item.label)).length < Math.ceil(series.length * 0.6)) return null;
  const first = series[0], last = series.at(-1);
  const change = rounded(last.value - first.value);
  const changePercent = first.value !== 0 ? rounded(change * 100 / Math.abs(first.value), 1) : null;
  const peak = series.reduce((best, item) => item.value > best.value ? item : best, series[0]);
  const trough = series.reduce((best, item) => item.value < best.value ? item : best, series[0]);
  const movements = series.slice(1).map((item, index) => item.value - series[index].value);
  const risingSteps = movements.filter((value) => value > 0).length;
  const fallingSteps = movements.filter((value) => value < 0).length;
  const direction = changePercent == null ? (change > 0 ? "up" : change < 0 ? "down" : "flat") : changePercent > 5 ? "up" : changePercent < -5 ? "down" : "stable";
  return { points: series.length, first, last, change, changePercent, direction, peak, trough, risingSteps, fallingSteps };
}

function buildEvidenceDigest(evidence, plan = {}) {
  const items = Array.isArray(evidence) ? evidence : [];
  const totalsItem = items.find((item) => item?.id === "totals") || items[0];
  const totals = totalsItem?.rows?.[0] || {};
  const detailItem = items.find((item) => item?.id === "detail") || items.find((item) => (item?.rows?.length || 0) > 1);
  const detailRows = Array.isArray(detailItem?.rows) ? detailItem.rows : [];
  const visualization = plan?.visualization || {};
  const summary = summarizeRows(detailRows, visualization);
  const { metricKey, ranked, leaders } = summary;
  const topGap = leaders.length > 1 ? rounded(leaders[0].value - leaders[1].value) : null;
  const topGapPercent = leaders.length > 1 && leaders[1].value !== 0
    ? rounded((leaders[0].value - leaders[1].value) * 100 / Math.abs(leaders[1].value), 1)
    : null;
  const totalNumbers = Object.fromEntries(numericEntries(totals).slice(0, 16));
  const netSales = Number(totalNumbers.NetSales);
  const grossProfit = Number(totalNumbers.GrossProfit);
  const discount = Number(totalNumbers.Discount ?? totalNumbers.TotalDiscount);
  const netQuantity = Number(totalNumbers.NetQuantity);
  const returnQuantity = Number(totalNumbers.ReturnQuantity);
  const stockQty = Number(totalNumbers.StockQty);
  const stockValue = Number(totalNumbers.StockValue);
  const transitQty = Number(totalNumbers.InTransitQty);
  const periodSoldQty = Number(totalNumbers.PeriodNetSoldQty);
  const transferInQty = Number(totalNumbers.TransferInQty);
  const transferOutQty = Number(totalNumbers.TransferOutQty);
  const purchaseQty = Number(totalNumbers.PurchaseQty);
  const ratios = {};
  if (Number.isFinite(netSales) && netSales !== 0 && Number.isFinite(grossProfit)) ratios.grossMarginPercent = rounded(grossProfit * 100 / netSales, 1);
  if (Number.isFinite(netSales) && netSales !== 0 && Number.isFinite(discount)) ratios.discountToNetSalesPercent = rounded(discount * 100 / Math.abs(netSales), 1);
  if (Number.isFinite(netQuantity) && Number.isFinite(returnQuantity) && netQuantity + returnQuantity > 0) ratios.returnToGrossQuantityPercent = rounded(returnQuantity * 100 / (netQuantity + returnQuantity), 1);
  if (Number.isFinite(netSales) && Number.isFinite(netQuantity) && netQuantity !== 0) ratios.averageSalesValuePerUnit = rounded(netSales / Math.abs(netQuantity));
  if (Number.isFinite(grossProfit) && Number.isFinite(netQuantity) && netQuantity !== 0) ratios.grossProfitPerUnit = rounded(grossProfit / Math.abs(netQuantity));
  if (Number.isFinite(stockValue) && Number.isFinite(stockQty) && stockQty !== 0) ratios.stockValuePerUnit = rounded(stockValue / stockQty);
  if (Number.isFinite(transitQty) && Number.isFinite(stockQty) && stockQty + transitQty !== 0) ratios.transitSharePercent = rounded(transitQty * 100 / (stockQty + transitQty), 1);
  if (Number.isFinite(periodSoldQty) && Number.isFinite(stockQty) && stockQty + Math.max(0, periodSoldQty) > 0) ratios.sellThroughPercent = rounded(Math.max(0, periodSoldQty) * 100 / (stockQty + Math.max(0, periodSoldQty)), 1);
  if (Number.isFinite(purchaseQty) && Number.isFinite(periodSoldQty) && periodSoldQty > 0) ratios.purchaseToSalesRatio = rounded(purchaseQty / periodSoldQty, 2);
  const secondaryItem = items.find((item) => item?.id === "secondary");
  const secondaryRows = Array.isArray(secondaryItem?.rows) ? secondaryItem.rows : [];
  const secondary = summarizeRows(secondaryRows, { labelKey: "Label", valueKey: visualization.valueKey });
  const trendRows = [detailRows, secondaryRows].find((rows) => rows.some((row) => /^\d{4}-\d{2}-\d{2}/.test(String(row?.Label || "")))) || [];
  const trend = analyzeTrend(trendRows, { labelKey: "Label", valueKey: visualization.valueKey });
  return {
    totals: totalNumbers,
    ratios,
    primaryDetailMetric: metricKey ? friendlyLabel(metricKey) : null,
    detailRowCount: detailRows.length,
    leaders,
    top3ConcentrationPercent: summary.top3SharePercent,
    topVsSecond: leaders.length > 1 ? { absoluteGap: topGap, percentGap: topGapPercent } : null,
    tail: ranked.length ? ranked.at(-1) : null,
    trend,
    secondary: { purpose: String(secondaryItem?.purpose || ""), rowCount: secondaryRows.length, metric: secondary.metricKey ? friendlyLabel(secondary.metricKey) : null, leaders: secondary.leaders.slice(0, 3), top3ConcentrationPercent: secondary.top3SharePercent },
    flow: Number.isFinite(transferInQty) && Number.isFinite(transferOutQty) ? { transferBalance: rounded(transferInQty - transferOutQty) } : null,
    negativeRows: ranked.filter((item) => item.value < 0).length || null,
    zeroRows: ranked.filter((item) => item.value === 0).length || null,
    emptyQueries: items.filter((item) => !item?.rows?.length).map((item) => String(item?.id || "unknown")),
    disclosedScope: Array.isArray(plan?.assumptions) ? plan.assumptions.map(String).slice(0, 8) : [],
  };
}

function collectAllowedNumbers(value, allowed) {
  if (typeof value === "number" && Number.isFinite(value)) {
    allowed.add(value);
    allowed.add(Math.round(value));
    allowed.add(rounded(value));
    allowed.add(rounded(value, 1));
  } else if (typeof value === "string") {
    for (const number of numbers(value)) allowed.add(number);
  } else if (Array.isArray(value)) {
    for (const item of value) collectAllowedNumbers(item, allowed);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectAllowedNumbers(item, allowed);
  }
}

function factualFallback(evidence, digest) {
  const facts = Object.entries(digest?.totals || {}).slice(0, 5)
    .map(([key, value]) => `${friendlyLabel(key)} ${Number(value).toLocaleString("en-PK", { maximumFractionDigits: 2 })}`);
  const leader = digest?.leaders?.[0];
  const runnerUp = digest?.leaders?.[1];
  const trend = digest?.trend;
  const highlights = [...facts];
  if (leader) highlights.push(`Sab se zyada: ${leader.label}${leader.sharePercent == null ? "" : ` · total mein ${leader.sharePercent}% hissa`}`);
  if (digest?.ratios?.grossMarginPercent != null) highlights.push(`Gross margin: ${digest.ratios.grossMarginPercent}%`);
  if (digest?.negativeRows) highlights.push(`${digest.negativeRows} negative-value group${digest.negativeRows === 1 ? "" : "s"} need review`);
  if (digest?.top3ConcentrationPercent != null) highlights.push(`Top 3 ka total hissa: ${digest.top3ConcentrationPercent}%`);
  if (trend) highlights.push(`Trend: ${trend.direction} · peak ${trend.peak.label}`);
  if (digest?.ratios?.sellThroughPercent != null) highlights.push(`Sell-through: ${digest.ratios.sellThroughPercent}%`);
  if (digest?.ratios?.transitSharePercent != null) highlights.push(`Transit share: ${digest.ratios.transitSharePercent}%`);
  const actions = [];
  if (leader?.sharePercent >= 50) actions.push(`${leader.label} ka hissa doosray number wale group se compare karein.`);
  if (digest?.negativeRows) actions.push("Negative-value groups ko returns, corrections ya stock exceptions ke liye review karein.");
  if (trend?.direction === "down") actions.push(`${trend.peak.label} ke mix ko latest period se compare karke quantity, discount aur returns driver isolate karein.`);
  if (digest?.ratios?.transitSharePercent >= 20) actions.push("Transit share high hai; pending transfers aur receiving delay ko branch-wise review karein.");
  if (digest?.ratios?.sellThroughPercent != null && digest.ratios.sellThroughPercent < 20) actions.push("Sell-through low hai; replenishment se pehle slow-moving product mix review karein.");
  return {
    answer: leader
      ? `Available data mein ${leader.label} sab se zyada hai${runnerUp ? `, aur ${runnerUp.label} doosray number par hai` : ""}.`
      : facts.length ? "Available data ka business summary tayar hai." : "Is sawal ke liye matching records nahi mile.",
    highlights: highlights.slice(0, 7),
    actions,
    suggestions: leader ? [`${leader.label} ka detailed product mix dikhao`, "Sab se zyada aur sab se kam groups compare karo", trend ? "Trend ke peak aur latest period ka driver comparison karo" : "Isi data ka time trend dikhao"] : [],
    confidence: facts.length ? "high" : "low",
  };
}

function groundExplanation(result, evidence, question, digest = buildEvidenceDigest(evidence)) {
  const allowed = new Set(numbers(question));
  collectAllowedNumbers(evidence, allowed);
  collectAllowedNumbers(digest, allowed);
  const claims = [result?.answer, ...(result?.highlights || []), ...(result?.actions || [])].join(" ");
  if (numbers(claims).every((number) => allowed.has(number))) return result;
  const fallback = factualFallback(evidence, digest);
  fallback.suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];
  return fallback;
}

module.exports = { buildEvidenceDigest, factualFallback, groundExplanation };
