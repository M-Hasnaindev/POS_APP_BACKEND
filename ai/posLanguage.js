const synonymGroups = Object.freeze({
  sales: ["sale", "sales", "selling", "sold", "revenue", "turnover", "net sale", "net sales", "bikri", "farokht", "salse", "saless", "sel", "sales amount", "فروخت", "سیلز", "ریونیو"],
  purchase: ["purchase", "purchases", "purchasing", "buying", "bought", "kharid", "khareed", "maal ki khareed", "purchse", "puchase", "purchas", "خرید", "خریداری"],
  purchase_return: ["purchase return", "supplier return", "vendor return", "purchase wapsi", "kharid wapsi", "khareed wapsi", "خریداری واپسی", "سپلائر واپسی"],
  return: ["return", "returns", "refund", "wapsi", "wapasi", "wapas", "sale return", "واپسی", "ریٹرن"],
  stock: ["stock", "inventory", "on hand", "available stock", "balance stock", "maal", "stok", "stck", "موجودہ مال", "اسٹاک", "انوینٹری"],
  branch: ["branch", "branches", "shop", "shops", "dukaan", "dukan", "dukkan", "dukaan", "outlet", "outlets", "retail outlet", "retail store", "store location", "business location", "brnch", "brach", "برانچ", "شاخ", "دکان", "آؤٹ لیٹ"],
  stockroom: ["stockroom", "stock room", "warehouse", "godown", "godaam", "godam", "gudam", "store room", "storeroom", "inventory location", "گودام", "اسٹاک روم", "ویئرہاؤس"],
  product: ["product", "products", "item", "items", "article", "articles", "barcode", "bar code", "barcod", "design", "design no", "sku", "maal", "پروڈکٹ", "آئٹم", "بارکوڈ", "ڈیزائن"],
  salesman: ["salesman", "salesmen", "sales person", "salesperson", "seller", "sales staff", "staff member", "staff", "employee", "sales executive", "سیلز مین", "سیلز پرسن", "ملازم", "اسٹاف"],
  supplier: ["supplier", "suppliers", "vendor", "vendors", "maal dene wala", "سپلائر", "وینڈر"],
  customer: ["customer", "customers", "client", "clients", "grahak", "buyer", "خریدار", "کسٹمر", "کلائنٹ"],
  account: ["account", "accounts", "party", "ledger", "کھاتہ", "اکاؤنٹ", "پارٹی"],
  payment: ["payment", "payments", "pay", "paid", "paying", "payment ki", "payment kari", "payment kare", "paisa", "paise", "paisa diya", "paise diye", "adaigi", "adayi", "tender", "cash", "card", "credit", "ادائیگی", "ادا", "کیش", "کارڈ", "کریڈٹ"],
  discount: ["discount", "discounts", "disc", "offer", "off", "markdown", "rate kam", "scheme", "ڈسکاؤنٹ", "آفر", "رعایت"],
  transfer: ["transfer", "transfers", "in transit", "sent", "received", "bheja", "bheji", "receive", "received qty", "ٹرانسفر", "بھیجا", "موصول"],
  stock_take: ["stock take", "stocktake", "physical stock", "physical count", "physical inventory", "فزیکل اسٹاک", "اسٹاک ٹیک"],
  adjustment: ["stock adjustment", "adjustment", "stock adj", "inventory adjustment", "ایڈجسٹمنٹ", "اسٹاک ایڈجسٹمنٹ"],
  opening_stock: ["opening stock", "stock opening", "opening quantity", "opening balance stock", "اوپننگ اسٹاک"],
  target: ["target", "targets", "benchmark", "goal", "sales target", "branch target", "ہدف", "ٹارگٹ", "بینچ مارک"],
  incentive: ["incentive", "incentives", "commission", "bonus", "reward", "انسینٹو", "کمیشن", "بونس"],
  hierarchy: ["hierarchy", "management hierarchy", "reporting line", "hod", "manager", "rsm", "asm", "branch manager", "country manager", "ہائیرارکی", "منیجر"],
  profit: ["profit", "gross profit", "margin", "kamai", "munafa", "منافع", "مارجن"],
  quantity: ["quantity", "qty", "pieces", "piece", "pcs", "units", "unit", "kitne piece", "kitni quantity", "مقدار", "پی سیز", "یونٹس"],
  amount: ["amount", "value", "sales value", "sale amount", "net amount", "rupees", "rs", "pkr", "رقم", "مالیت"],
  bills: ["bill", "bills", "invoice", "invoices", "transaction", "receipt", "بل", "انوائس", "رسید"],
  forecast: ["forecast", "prediction", "predict", "projection", "future estimate", "expected", "andaza", "andaaza", "پیش گوئی", "اندازہ", "آئندہ"],
  analysis: ["analysis", "analyze", "analyse", "why", "reason", "cause", "root cause", "trend", "growth", "decline", "performance review", "kyun", "wajah", "تجزیہ", "کیوں", "وجہ", "رجحان"],
  top: ["top", "best", "highest", "most", "maximum", "sab se zyada", "sabse zyada", "sab se ziyada", "sabse ziyada", "زیادہ", "سب سے زیادہ", "بہترین"],
  bottom: ["bottom", "worst", "lowest", "sab se kam", "sabse kam", "سب سے کم", "کم ترین"],
  compare: ["compare", "comparison", "versus", "vs", "muqabla", "mukabla", "فرق", "موازنہ", "مقابلہ"],
  brand: ["brand", "brands", "برانڈ"],
  category: ["category", "categories", "catagory", "catagories", "کیٹیگری"],
  color: ["color", "colour", "rang", "رنگ"],
  size: ["size", "sizes", "سائز"],
  season: ["season", "seasons", "mosam", "موسم"],
  counter: ["counter", "pos counter", "till", "cash counter", "کاؤنٹر"],
});

const romanCues = Object.freeze([
  "aaj", "aj", "kal", "parson", "pichla", "pichlay", "pichle", "iss", "batao", "btao", "dikhao", "kitna", "kitni", "kitne", "kis", "konsi", "kaunsi", "sab se", "zyada", "kam", "wali", "wala", "mein", "se", "tak", "bikri", "farokht", "kharid", "khareed", "maal", "wapsi", "wapas", "dukaan", "dukan", "aglay", "agle", "mangwa", "kyun", "wajah", "muqabla", "godaam", "godown",
]);

function normalizeBasic(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseRegex(phrase) {
  const escaped = normalizeBasic(phrase)
    .split(" ")
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, "i");
}

const compiledGroups = Object.freeze(Object.fromEntries(
  Object.entries(synonymGroups).map(([concept, phrases]) => [
    concept,
    phrases.map((phrase) => ({ phrase, regex: phraseRegex(phrase) })),
  ]),
));

const FUZZY_SINGLE_WORDS = Object.freeze({
  sale: "sales", sales: "sales", revenue: "sales", bikri: "sales", farokht: "sales",
  purchase: "purchase", purchasing: "purchase", kharid: "purchase", khareed: "purchase",
  stock: "stock", inventory: "stock",
  branch: "branch", shop: "branch", dukaan: "branch", dukan: "branch", outlet: "branch",
  stockroom: "stockroom", warehouse: "stockroom", godown: "stockroom", godaam: "stockroom",
  product: "product", item: "product", article: "product", barcode: "product", design: "product",
  salesman: "salesman", salesperson: "salesman", employee: "salesman",
  supplier: "supplier", vendor: "supplier", customer: "customer", client: "customer",
  discount: "discount", transfer: "transfer", target: "target", incentive: "incentive",
  profit: "profit", margin: "profit", quantity: "quantity", amount: "amount",
  forecast: "forecast", prediction: "forecast", analysis: "analysis", compare: "compare",
  brand: "brand", category: "category", color: "color", colour: "color", size: "size", season: "season",
});

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}

function addFuzzyConcepts(normalized, found) {
  const tokens = normalized.split(" ").filter((token) => /^[a-z]+$/.test(token) && token.length >= 5);
  for (const token of tokens) {
    for (const [known, concept] of Object.entries(FUZZY_SINGLE_WORDS)) {
      if (known.length < 5 || Math.abs(token.length - known.length) > 1) continue;
      if (editDistanceAtMostOne(token, known)) { found.add(concept); break; }
    }
  }
}

function conceptsForText(value) {
  const normalized = normalizeBasic(value);
  const found = new Set();
  if (!normalized) return found;
  for (const [concept, phrases] of Object.entries(compiledGroups)) {
    if (phrases.some((item) => item.regex.test(normalized))) found.add(concept);
  }
  addFuzzyConcepts(normalized, found);
  // Context-sensitive aliases that should not be globally collapsed.
  if (/(?:^|\s)store(?=\s|$)/i.test(normalized) && !found.has("branch")) found.add("stockroom");
  if (/(?:^|\s)party(?=\s|$)/i.test(normalized)) found.add("account");
  return found;
}

function canonicalizeForRouting(value) {
  const normalized = normalizeBasic(value);
  const concepts = [...conceptsForText(normalized)];
  return `${normalized}${concepts.length ? ` ${concepts.join(" ")}` : ""}`.trim();
}

function tokenizeBusiness(value) {
  const normalized = normalizeBasic(value);
  const tokens = normalized.split(" ").filter((token) => token.length >= 2);
  for (const concept of conceptsForText(normalized)) tokens.push(`concept_${concept}`);
  return [...new Set(tokens)];
}

function looksRomanUrdu(value) {
  const normalized = ` ${normalizeBasic(value)} `;
  return romanCues.some((cue) => normalized.includes(` ${normalizeBasic(cue)} `));
}

module.exports = {
  synonymGroups,
  normalizeBasic,
  conceptsForText,
  canonicalizeForRouting,
  tokenizeBusiness,
  looksRomanUrdu,
};
