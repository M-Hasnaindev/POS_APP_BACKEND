const { canonicalizeForRouting, conceptsForText, normalizeBasic } = require("./posLanguage");

const DIMENSION_PATTERNS = Object.freeze([
  ["branch", /\b(branch|branches|shop|shops|dukaan|dukan|dukkan|outlet|outlets|retail outlet|store location)\b/i, /(برانچ|شاخ|دکان|آؤٹ لیٹ)/i],
  ["store", /\b(stock ?room|warehouse|godown|godaam|store room|storeroom|inventory location)\b/i, /(گودام|اسٹاک روم|ویئرہاؤس)/i],
  ["salesman", /\b(salesman|salesmen|sales person|salesperson|sales staff|staff member|seller|employee|sales executive)\b/i, /(سیلز مین|سیلز پرسن|ملازم|اسٹاف)/i],
  ["supplier", /\b(supplier|vendor|party supplier|maal dene wala)\b/i, /(سپلائر|وینڈر)/i],
  ["barcode", /\b(bar ?code|barcode|sku|item|product|article)\b/i, /(بارکوڈ|آئٹم|پروڈکٹ)/i],
  ["design", /\b(design|design no|article design)\b/i, /(ڈیزائن)/i],
  ["brand", /\bbrand(?:s)?\b/i, /برانڈ/i],
  ["category", /\bcat(?:e|a)g(?:ory|ories)\b/i, /کیٹیگری/i],
  ["subcategory", /\bsub\s*cat(?:e|a)g(?:ory|ories)|sub-category\b/i, /سب\s*کیٹیگری/i],
  ["department", /\bdepartment(?:s)?\b/i, /ڈیپارٹمنٹ/i],
  ["subdepartment", /\bsub\s*department|sub-department\b/i, /سب\s*ڈیپارٹمنٹ/i],
  ["style", /\bstyle(?:s)?\b/i, /اسٹائل/i],
  ["season", /\bseason(?:s)?\b/i, /موسم/i],
  ["fabric", /\bfabric(?:s)?\b/i, /فیبرک/i],
  ["gender", /\bgender\b/i, /جینڈر/i],
  ["size", /\bsize(?:s)?\b/i, /سائز/i],
  ["color", /\bcolo(?:u)?r(?:s)?\b/i, /رنگ/i],
  ["day", /\b(day wise|day-wise|daily|rozana|day by day)\b/i, /(روزانہ|دن وائز)/i],
  ["week", /\b(week wise|weekly)\b/i, /(ہفتہ وائز|ہفتہ وار)/i],
  ["month", /\b(month wise|monthly)\b/i, /(ماہانہ|مہینہ وائز)/i],
  ["invoice", /\b(invoice wise|bill wise|receipt wise|transaction wise)\b/i, /(انوائس وائز|بل وائز)/i],
]);

const REPORT_BY_DIMENSION = Object.freeze({
  sales: {
    branch: "RPT_02_005_BRANCH_WISE_SALES",
    store: "RPT_02_006_STORE_WISE_SALES",
    invoice: "RPT_02_007_INVOICE_WISE_SALES",
    barcode: "RPT_02_008_BARCODE_WISE_SALES",
    design: "RPT_02_009_DESIGN_WISE_SALES",
    brand: "RPT_02_010_BRAND_WISE_SALES",
    category: "RPT_02_012_CATEGORY_WISE_SALES",
    subcategory: "RPT_02_013_SUBCATEGORY_WISE_SALES",
    department: "RPT_02_014_DEPARTMENT_WISE_SALES",
    subdepartment: "RPT_02_015_SUBDEPARTMENT_WISE_SALES",
    style: "RPT_02_016_STYLE_SUBSTYLE_WISE_SALES",
    season: "RPT_02_017_SEASON_WISE_SALES",
    fabric: "RPT_02_018_FABRIC_WISE_SALES",
    gender: "RPT_02_019_GENDER_WISE_SALES",
    size: "RPT_02_020_SIZE_WISE_SALES",
    color: "RPT_02_021_COLOR_WISE_SALES",
    day: "RPT_02_002_DAILY_SALES",
    week: "RPT_02_003_WEEKLY_SALES",
    month: "RPT_02_004_MONTHLY_SALES",
  },
  stock: {
    branch: "RPT_03_003_BRANCH_WISE_STOCK",
    store: "RPT_03_004_STORE_WISE_STOCK",
    design: "RPT_03_005_DESIGN_WISE_STOCK",
    brand: "RPT_03_006_BRAND_WISE_STOCK",
    category: "RPT_03_007_CATEGORY_WISE_STOCK",
    department: "RPT_03_008_DEPARTMENT_WISE_STOCK",
    season: "RPT_03_009_SEASON_WISE_STOCK",
    gender: "RPT_03_010_GENDER_WISE_STOCK",
    size: "RPT_03_011_SIZE_WISE_STOCK",
    color: "RPT_03_012_COLOR_WISE_STOCK",
  },
  purchase: {
    supplier: "RPT_05_003_SUPPLIER_WISE_PURCHASE",
    barcode: "RPT_05_004_BARCODE_WISE_PURCHASE",
    design: "RPT_05_005_DESIGN_WISE_PURCHASE",
    brand: "RPT_05_006_BRAND_WISE_PURCHASE",
    category: "RPT_05_007_CATEGORY_WISE_PURCHASE",
  },
});

const HARD_UNSUPPORTED_STOCK = /\b(negative stock|zero stock|low stock|overstock|dead stock|non[- ]?moving|slow moving|fast moving|stock aging|ageing|days since last sale|days since last movement|stock turnover|sell through|weeks? of supply|stock cover|broken size|missing size|missing color|stock imbalance)\b/i;

function hasAny(text, regex, urduRegex) {
  return regex.test(text) || (urduRegex ? urduRegex.test(String(text || "")) : false);
}

function detectDimension(question) {
  const raw = String(question || "");
  const text = canonicalizeForRouting(raw);
  const breakdownCue = /\b(wise|by |ranking|rank|top|bottom|best|worst|highest|lowest|which|kis|konsi|kaunsi|tamam|all)\b/i.test(text)
    || /(وائز|سب سے زیادہ|سب سے کم|کون|کس|تمام)/i.test(raw);
  const explicitTimeDimension = /\b(day wise|day-wise|daily|week wise|weekly|month wise|monthly|invoice wise|bill wise)\b/i.test(text)
    || /(روزانہ|دن وائز|ہفتہ وار|ماہانہ|انوائس وائز|بل وائز)/i.test(raw);
  for (const [dimension, english, urdu] of DIMENSION_PATTERNS) {
    const matches = english.test(text) || urdu.test(raw);
    if (!matches) continue;
    if (["day", "week", "month", "invoice"].includes(dimension)) {
      if (explicitTimeDimension) return dimension;
      continue;
    }
    if (breakdownCue) return dimension;
  }
  if (/\bsize\b/i.test(text) && /\bcolo(?:u)?r\b/i.test(text) && breakdownCue) return "size-color";
  return null;
}

function detectMetrics(question) {
  const raw = String(question || "");
  const text = canonicalizeForRouting(raw);
  const metrics = new Set();
  if (/\b(qty|quantity|pieces?|pcs|units?|volume)\b/i.test(text) || /(مقدار|تعداد|پیس|یونٹ)/i.test(raw)) metrics.add("quantity");
  if (/\b(amount|value|revenue|net sales?|sale amount|sales value|rupees?|pkr|rs)\b/i.test(text) || /(رقم|مالیت|نیٹ سیلز|ریونیو)/i.test(raw)) metrics.add("amount");
  if (/\b(bills?|invoice count|transaction count|receipt count)\b/i.test(text) || /(بلز?|انوائس.*تعداد|رسید.*تعداد)/i.test(raw)) metrics.add("bills");
  if (/\b(discount|disc|markdown|rebate|r[iy]ayat)\b/i.test(text) || /(ڈسکاؤنٹ|رعایت)/i.test(raw)) metrics.add("discount");
  if (/\b(gross profit|profit|munafa|kamai)\b/i.test(text) || /منافع/i.test(raw)) metrics.add("profit");
  if (/\bmargin\b/i.test(text) || /مارجن/i.test(raw)) metrics.add("margin");
  if (/\b(gst|tax|taxable|fbr)\b/i.test(text) || /(جی ایس ٹی|ٹیکس|ایف بی آر)/i.test(raw)) metrics.add("tax");
  if (/\b(sent|bhej|dispatched)\b/i.test(text) || /بھیج/i.test(raw)) metrics.add("sent");
  if (/\b(received|receive|mila|receipt qty)\b/i.test(text) || /موصول/i.test(raw)) metrics.add("received");
  if (/\b(in transit|pending transfer|pending qty)\b/i.test(text) || /(راستے میں|زیر ترسیل)/i.test(raw)) metrics.add("pending");
  if (/\b(cost value|at cost|cost valuation)\b/i.test(text) || /(لاگت.*ویلیو|لاگت پر)/i.test(raw)) metrics.add("stock-cost-value");
  if (/\b(purchase value|purchase valuation)\b/i.test(text) || /(خریداری.*ویلیو|خرید.*مالیت)/i.test(raw)) metrics.add("stock-purchase-value");
  if (/\b(retail value|selling value|sale price value|mrp value)\b/i.test(text) || /(ریٹیل.*ویلیو|فروختی.*مالیت)/i.test(raw)) metrics.add("stock-retail-value");
  if (/\b(discount value|discounted value)\b/i.test(text) || /(ڈسکاؤنٹ.*ویلیو)/i.test(raw)) metrics.add("stock-discount-value");
  if (/\b(count|how many|kitne|kitni tadaad)\b/i.test(text) || /(کتنے|کتنی تعداد)/i.test(raw)) metrics.add("count");
  return [...metrics];
}

function detectOperation(question) {
  const raw = String(question || "");
  const text = canonicalizeForRouting(raw);
  if (/\b(forecast|predict|prediction|projection|future|expected|estimate|andaza|andaaza|next|agle|aglay|agli)\b/i.test(text) || /(پیش گوئی|اندازہ|آئندہ|اگلے)/i.test(raw)) return "forecast";
  if (/\b(analy(?:s|z)e|analysis|why|kyun|reason|cause|root cause|strategy|risk|anomaly|recommend|suggest|management action|performance review)\b/i.test(text) || /(تجزیہ|کیوں|وجہ|حکمت عملی|خطرہ|مشورہ)/i.test(raw)) return "analysis";
  if (/\b(compare|comparison|versus|vs|muqabla|mukabla|difference|growth|decline)\b/i.test(text) || /(موازنہ|مقابلہ|فرق|اضافہ|کمی)/i.test(raw)) return "compare";
  if (/\b(bottom|worst|lowest|sab se kam|sabse kam)\b/i.test(text) || /سب سے کم/i.test(raw)) return "rank-bottom";
  if (/\b(top|best|highest|sab se z(?:y|iy)ada|sabse z(?:y|iy)ada)\b/i.test(text) || /سب سے زیادہ/i.test(raw)) return "rank-top";
  if (/\b(trend|daily|day wise|weekly|month wise|monthly|timeline)\b/i.test(text) || /(رجحان|روزانہ|ہفتہ وار|ماہانہ)/i.test(raw)) return "trend";
  if (/\b(wise|breakdown|split|distribution|list|detail|details|show all|tamam)\b/i.test(text) || /(وائز|تفصیل|تمام)/i.test(raw)) return "breakdown";
  return "summary";
}

function detectDomain(question) {
  const raw = String(question || "");
  const text = canonicalizeForRouting(raw);
  const concepts = conceptsForText(raw);
  const discountPolicy = concepts.has("discount") && /\b(policy|policies|active|apply|applicable|eligible|scheme|valid|validity|from|to|latest policy)\b/i.test(text);
  const tax = /\b(fbr|gst|taxable|tax summary|tax sales)\b/i.test(text) || /(ایف بی آر|جی ایس ٹی|ٹیکس)/i.test(raw);

  if (/\b[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*\b/.test(raw)
    || /\b(field|column|table|schema|business meaning|field meaning)\b/i.test(text)
    || /(فیلڈ|کالم|ٹیبل|معنی)/i.test(raw)) return "schema";
  if (concepts.has("target") || concepts.has("incentive") || concepts.has("hierarchy")) return "target-incentive";
  if (discountPolicy) return "discount-policy";
  if (tax) return "sales-tax";
  // Supplier/vendor payment is an accounting intent and must win over words
  // like "received" (which can otherwise look like stock transfer).
  const earlySupplierPayment = concepts.has("supplier") && concepts.has("payment")
    && !concepts.has("sales")
    && !/\b(payment mix|cash sales?|card sales?|credit sales?|tender)\b/i.test(text);
  if (earlySupplierPayment) return "accounts";
  if (concepts.has("purchase_return")) return "purchase-return";
  if (concepts.has("stock_take")) return "stock-take";
  if (concepts.has("adjustment")) return "adjustment";
  if (concepts.has("opening_stock")) return "opening-stock";
  if (concepts.has("transfer")) return "transfer";
  if (concepts.has("stock") && (/\b(value|valuation|worth|on hand|available|balance stock)\b/i.test(text) || /(ویلیو|مالیت|موجودہ)/i.test(raw))) return "stock";
  if (concepts.has("purchase")) return "purchase";
  // Tender wording such as "cash sales", "card sale" or "credit sales" is a payment-mix
  // question even though the sentence also contains the word sales.  This must be decided
  // before the generic sales domain or the assistant can answer total sales instead of the
  // tender amount the user actually asked for.
  const explicitTender = concepts.has("payment") && (/\b(cash|card|credit|tender|payment|payments|payment method|pay method|payment mix|cash card|cash\/card)\b/i.test(text) || /(کیش|کارڈ|کریڈٹ|ادائیگی)/i.test(raw));
  if (explicitTender) return "payment";
  if (concepts.has("payment") && !concepts.has("sales")) return "payment";
  if (concepts.has("stock")) return "stock";
  if (concepts.has("sales") || concepts.has("return") || concepts.has("profit") || concepts.has("bills")) return "sales";
  if (concepts.has("payment")) return "payment";
  if (concepts.has("product") || concepts.has("brand") || concepts.has("category") || concepts.has("color") || concepts.has("size") || concepts.has("season")) return "product";
  if (concepts.has("customer") || concepts.has("supplier") || concepts.has("account")) return "accounts";
  if (concepts.has("branch") || concepts.has("stockroom") || concepts.has("salesman") || concepts.has("counter")) return "masterdata";
  return null;
}

function detectSpecial(question, domain) {
  const raw = String(question || "");
  const text = canonicalizeForRouting(raw);
  if (domain === "sales" && /\b(return|returns|refund|wapsi|wapasi|wapas)\b/i.test(text) || (domain === "sales" && /(واپسی|ریٹرن)/i.test(raw))) return "sales-return";
  if (domain === "stock" && HARD_UNSUPPORTED_STOCK.test(text)) {
    if (/negative stock/i.test(text)) return "negative-stock";
    if (/zero stock/i.test(text)) return "zero-stock";
    if (/low stock/i.test(text)) return "low-stock";
    if (/overstock/i.test(text)) return "overstock";
    if (/dead stock/i.test(text)) return "dead-stock";
    if (/non[- ]?moving/i.test(text)) return "non-moving-stock";
    if (/slow moving/i.test(text)) return "slow-moving-stock";
    if (/fast moving/i.test(text)) return "fast-moving-stock";
    if (/aging|ageing/i.test(text)) return "stock-aging";
    if (/stock cover|weeks? of supply/i.test(text)) return "stock-cover";
    return "advanced-stock";
  }
  if (domain === "stock" && /\b(value|valuation|worth)\b/i.test(text)) return "stock-valuation";
  if (domain === "accounts" && conceptsForText(raw).has("supplier") && conceptsForText(raw).has("payment")) return "supplier-payment";
  if (domain === "payment") return "payment-mix";
  if (domain === "sales-tax") return "fbr-tax";
  if (domain === "discount-policy") return "discount-policy";
  if (domain === "target-incentive") {
    if (/hierarchy|hod|manager|rsm|asm|country manager|branch manager/i.test(text) || /ہائیرارکی|منیجر/i.test(raw)) return "hierarchy";
    if (/category.*salesman|salesman.*category/i.test(text)) return "category-salesman-incentive";
    if (/salesman|employee|staff/i.test(text)) return "salesman-incentive";
    if (/category|brand|supplier/i.test(text)) return "category-incentive";
    return "branch-target-incentive";
  }
  return null;
}

function parseSurfaceIntent(question) {
  const raw = String(question || "").trim();
  const normalized = normalizeBasic(raw);
  const concepts = [...conceptsForText(raw)];
  const domain = detectDomain(raw);
  const dimension = detectDimension(raw);
  const metrics = detectMetrics(raw);
  const operation = detectOperation(raw);
  const special = detectSpecial(raw, domain);
  const asksBreakdown = Boolean(dimension) || ["rank-top", "rank-bottom", "breakdown", "trend"].includes(operation);
  const explicitSignals = [domain, dimension, special, ...metrics].filter(Boolean).length;
  return { normalized, domain, dimension, metrics, operation, special, concepts, asksBreakdown, explicitSignals };
}

function verifiedRouteForIntent(intent) {
  if (!intent || !intent.domain) return { kind: "planner", reason: "no-domain-guarded-planner" };
  const { domain, dimension, special, operation } = intent;
  if (domain === "schema") return { kind: "schema", reason: "documented-schema" };
  if (operation === "forecast") {
    if (["sales", "stock"].includes(domain)) return { kind: "forecast", reason: "deterministic-forecast" };
    return { kind: "planner", reason: "complex-forecast" };
  }
  if (domain === "sales") {
    if (special === "sales-return") return { kind: "direct-engine", engine: "sales-return", dimension, reason: "verified-sales-return" };
    if (dimension === "size-color") return { kind: "planner", reason: "size-color-sales-needs-two-dimension-sql" };
    if (dimension === "salesman") return { kind: "direct-engine", engine: "sales-dimension", dimension:"salesman", reason:"verified-salesman-sales" };
    const code = dimension ? REPORT_BY_DIMENSION.sales[dimension] : "RPT_02_001_SALES_SUMMARY";
    if (code) return { kind: "report", code, reason: "verified-sales" };
    return { kind: "planner", reason: "unsupported-sales-dimension" };
  }
  if (domain === "sales-tax") return { kind: "report", code: "RPT_26_001_FBR_SALES_SUMMARY", reason: "verified-fbr" };
  if (domain === "payment") return { kind: "report", code: "RPT_02_032_CASH_CARD_CREDIT_SALES", reason: "verified-payment" };
  if (domain === "stock") {
    if (special && special !== "stock-valuation") return { kind: "planner", reason: `advanced-stock:${special}` };
    if (dimension === "size-color") return { kind: "planner", reason: "size-color-stock-needs-two-dimension-sql" };
    const code = dimension ? REPORT_BY_DIMENSION.stock[dimension] : "RPT_03_001_CURRENT_STOCK";
    if (code) return { kind: "report", code, reason: special === "stock-valuation" ? "verified-stock-valuation" : "verified-stock" };
    return { kind: "planner", reason: "unsupported-stock-dimension" };
  }
  if (domain === "purchase") {
    if (dimension === "size-color") return { kind: "planner", reason: "size-color-purchase-needs-two-dimension-sql" };
    const code = dimension ? REPORT_BY_DIMENSION.purchase[dimension] : "RPT_05_001_PURCHASE_REGISTER";
    if (code) return { kind: "report", code, reason: "verified-purchase" };
    return { kind: "planner", reason: "unsupported-purchase-dimension" };
  }
  if (domain === "purchase-return") return { kind: "direct-engine", engine: "purchase-return", dimension, reason: "verified-purchase-return" };
  if (domain === "transfer") return { kind: "report", code: "RPT_06_013_SENT_VS_RECEIVED_QUANTITY", reason: "verified-transfer" };
  if (domain === "stock-take") return { kind: "direct-engine", engine: "stock-take", reason: "verified-stock-take" };
  if (domain === "adjustment") return { kind: "direct-engine", engine: "adjustment", reason: "verified-adjustment" };
  if (domain === "discount-policy") return { kind: "report", code: "RPT_16_016_DISCOUNT_POLICY_COMPLIANCE", reason: "verified-discount-policy" };
  if (domain === "product") return { kind: "report", code: "RPT_07_001_BARCODE_MASTER", reason: "verified-product-master" };
  if (domain === "accounts" && special === "supplier-payment") return { kind: "direct-engine", engine: "supplier-payment", dimension: "supplier", reason: "verified-accounting-supplier-payment" };
  if (domain === "opening-stock") return { kind: "planner", reason: "opening-stock-needs-specific-ledger" };
  if (["target-incentive", "accounts", "masterdata"].includes(domain)) return { kind: "planner", reason: `guarded-${domain}` };
  return { kind: "planner", reason: "guarded-fallback" };
}

function intentSignature(intent) {
  if (!intent) return "unknown";
  return [intent.domain || "?", intent.special || "-", intent.dimension || "-", intent.operation || "summary", [...(intent.metrics || [])].sort().join("+") || "default"].join("|");
}

module.exports = {
  parseSurfaceIntent,
  verifiedRouteForIntent,
  intentSignature,
  REPORT_BY_DIMENSION,
};
