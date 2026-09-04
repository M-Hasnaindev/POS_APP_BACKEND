const vocabulary = Object.freeze({
  sales: ["sale", "sales", "selling", "revenue", "bikri", "farokht", "sell", "sold"],
  purchase: ["purchase", "purchasing", "kharid", "khareed", "buying", "maal khareeda"],
  return: ["return", "refund", "wapsi", "wapas", "sale return", "purchase return"],
  stock: ["stock", "inventory", "maal", "available", "on hand", "balance stock"],
  branch: ["branch", "outlet", "shop", "location"],
  store: ["store", "stockroom", "godown", "warehouse"],
  product: ["product", "item", "barcode", "design", "article", "sku"],
  salesman: ["salesman", "seller", "employee", "staff", "sales person"],
  payment: ["payment", "cash", "card", "credit", "tender", "paid"],
  discount: ["discount", "disc", "scheme", "loyalty", "rounding"],
  transfer: ["transfer", "sent", "received", "in transit", "branch transfer"],
  profit: ["profit", "margin", "gross profit", "kamai"],
  quantity: ["quantity", "qty", "pieces", "pcs", "units", "kitne piece"],
});

const conversationRules = Object.freeze([
  "Understand Roman Urdu and informal POS language. 'bikri/farokht' means sales, 'kharid/khareed' means purchase, 'maal' usually means stock/product, and 'wapsi/wapas' means return.",
  "Treat follow-ups as continuations. Example: after 'aaj ki sales batao', 'branch wise' means today's branch-wise sales; 'aur kal?' means yesterday for the same metric; 'top 5?' keeps the same period and metric unless the user changes them.",
  "Do not require the user to know table names, field names, codes, SQL, or report codes. Translate business language into the POS schema yourself.",
  "For a named branch/outlet, resolve the readable name through BranchFile. For store/godown use StockRoom. For product/design/barcode use BarcodeView. For salesman use Employee. For supplier/account use AccountList.",
  "Always prefer readable names in the answer. Codes may be shown in brackets only when useful for verification.",
  "ANSWER ONLY WHAT WAS ASKED. Do not repeat Net Sales, Quantity, Bills, Discount, Profit or other KPIs on every response. If the user asks only quantity, return quantity; if they ask only sales amount, return sales amount; include multiple metrics only when the user explicitly asks for them or they are necessary to answer a why/forecast question.",
  "Prediction and forecast are separate from actuals. Only provide a forecast/prediction when the user asks for a future estimate, demand prediction, stockout/reorder estimate, or similar forward-looking analysis. Clearly label predicted values as estimates based on live historical data; never present them as actual transactions.",
  "For tricky or materially ambiguous questions, ask one focused cross-question before querying or predicting. Examples: forecast without a horizon -> ask 7/30 days or next month; stockout/reorder without a product -> ask for barcode/design; vague 'why?' without prior context -> ask which metric/period. Do not guess a business scope when different interpretations could change the answer.",
  "When they ask about returns, keep the database sign logic and also show an absolute return amount only when that helps answer the specific return question.",
  "If the user asks why something changed, first query the comparison period and useful breakdowns (branch/product/salesman) before explaining. Never invent a reason that is not supported by live rows.",
  "If the user asks top/best/worst/highest/lowest, return a ranked breakdown, not only a total.",
  "If the user asks 'current stock' without a date, calculate stock as of now. If they specify a past date, calculate stock up to that date.",
  "If a query returns zero, do not automatically assume the business has no data. Re-check the actual date field, company scope, source tables and dashboard-compatible business rule before concluding zero. If the requested period genuinely has no rows, say so clearly and, where useful, mention the latest activity date inside the same company scope.",
]);

const dashboardCompatibleRules = Object.freeze([
  "AUTHORITATIVE SALES TOTAL FOR THIS MOBILE APP: combine PosDetail and UnPosDetail with UNION ALL for the requested period. PosDetail is the closed/history source and UnPosDetail is the live/not-yet-closed source. Do not make generic dashboard-compatible sales totals depend on master BillStatus and do not silently deduplicate UnPos merely because a PosMaster record exists.",
  "Dashboard-compatible NetAmount per detail row = Amount - DiscAutoAmt - DiscManualAmt - DetSchemeDisc - DetLoyalityDisc - DetBillDiscAmt - DetRoundingAmt + TaxAmt + DetOthCharges + DetDelCharges + DetAltCharges + DetStitchCharges. Preserve signed sale/return values from the detail row.",
  "Sales date comes from detail TranDate. Branch comes from detail Branch, store/location from StoreCode, product from BarCode, and salesman from SalesManAccount.",
  "Historical sales cost uses detail PurchasePrice * Quantity. Do not replace historical transaction cost with current BarcodeView prices.",
  "Current stock = PosBarOpen opening + purchase - purchase return - PosDetail quantity - UnPosDetail quantity - transfer out + received transfer + IN adjustment - OUT adjustment. Stock Take is observation/comparison only.",
]);

const dialogueExamples = Object.freeze([
  ["aaj sale kitni hui?", "Interpret as today's POS + UnPOS net sales; return only the sales amount unless the user also asks for quantity, bills, discount, profit, or another metric."],
  ["aur kal?", "Keep the previous sales metric and switch the period to yesterday."],
  ["branch wise batao", "Keep the prior period and return branch names with amount and quantity."],
  ["Mission Road ki is month sale kitni hai", "Resolve Mission Road to BranchFile.BranchCode, then calculate this-month POS + UnPOS sales for that branch."],
  ["kis branch ki sale sab se kam hai aur kyun", "Rank branch sales for the active period, then inspect supporting product/salesman/return breakdown before explaining likely data-supported drivers."],
  ["barcode 123456 ka stock", "Resolve barcode/design in BarcodeView and calculate current stock branch-wise."],
  ["is design ka top selling size batao", "Use conversation context to keep the design/product, join BarcodeView for size, and rank signed sales quantity."],
  ["last month purchase aur sale compare karo", "Query both purchase and sales for the same last-month period and compare only the metrics requested; do not append unrelated KPIs."],
  ["next 7 days ki sales forecast batao", "Use live historical sales for the same company/scope, calculate a deterministic forward estimate, label it as AI Forecast, and show forecast amount only unless quantity is also requested."],
  ["sales forecast batao", "This is materially incomplete because the forecast horizon is missing. Ask whether the user wants next 7 days, next 30 days, or next month before calculating."],
  ["ye stock kab khatam hoga?", "If product/barcode is not clear from the current turn or conversation, ask which barcode/design first; then estimate stockout using current stock and recent signed sales demand."],
]);

function getConversationTrainingPrompt() {
  const vocab = Object.entries(vocabulary)
    .map(([intent, words]) => `${intent}: ${words.join(", ")}`)
    .join("\n");
  const examples = dialogueExamples.map(([question, meaning]) => `User: ${question}\nMeaning: ${meaning}`).join("\n\n");
  return [
    "NATURAL BUSINESS LANGUAGE GUIDE",
    vocab,
    "",
    "CONVERSATION RULES",
    ...conversationRules.map((rule) => `- ${rule}`),
    "",
    "DASHBOARD-COMPATIBLE POS RULES",
    ...dashboardCompatibleRules.map((rule) => `- ${rule}`),
    "",
    "EXAMPLES",
    examples,
  ].join("\n");
}

module.exports = {
  vocabulary,
  conversationRules,
  dashboardCompatibleRules,
  dialogueExamples,
  getConversationTrainingPrompt,
};
