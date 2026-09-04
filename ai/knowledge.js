const trainingKnowledge = require("./trainingKnowledge.generated.json");

const allowedTables = Object.freeze([
  "BranchFile", "StockRoom", "BarcodeView", "AccountList", "Employee", "Defaults",
  "PosMaster", "PosDetail", "PosPayment", "UnPosMaster", "UnPosDetail", "UnPosPayment",
  "PosPurchaseM", "PosPurchaseD", "PosPReturnM", "PosPReturnD",
  "PosTransferM", "PosTransferD", "PosBarOpen", "PosBarcodeAdjM", "PosBarcodeAdjD",
  "PosStockAdjM", "PosStockAdjD", "PosStockTakeM", "PosStockTakeD",
  "PosDiscount", "PosBranchIncentive", "PosSalesmanIncentive",
  "PosCategoryIncentive", "PosCategoryWiseSalesmanIncentive",
  "PosTargetMaster", "PosTargetDetail", "PosMasterFile", "PosDetailFile", "PosIdMap",
]);

const tablePurposes = Object.freeze({
  PosDetail: "closed/historical item-level sales fact; signed return rows; transaction-time cost",
  UnPosDetail: "live/before-closing item-level sales fact; deduplicate against PosMaster",
  PosMaster: "closed sale header; BillStatus P is paid",
  UnPosMaster: "live sale header; BillStatus P is paid",
  PosPurchaseD: "purchase item-level amount and quantity fact",
  PosPurchaseM: "purchase date, supplier and header",
  PosPReturnD: "purchase-return item-level amount and stock-out quantity fact",
  PosPReturnM: "purchase-return date, supplier and header",
  PosTransferD: "sent Quantity and received RecQuantity/RecStatus item-level fact",
  PosTransferM: "transfer date/source/destination header",
  PosBarOpen: "opening stock by barcode, branch and store",
  PosBarcodeAdjM: "barcode-adjustment header; semantics not documented in the training workbook",
  PosBarcodeAdjD: "barcode-adjustment lines with BarCode, BarCodeAdj and Quantity; stock direction requires clarification",
  PosStockAdjD: "stock adjustment lines; EntryType IN adds, OUT removes",
  PosStockTakeD: "physical count only; never directly changes current stock",
  BarcodeView: "product names and merchandise attributes; not historical transaction cost",
  BranchFile: "branch code to BranchName; Type D is transaction branch",
  StockRoom: "store code to Name and owning branch; Type D is transaction store",
  AccountList: "account/supplier code ActCod to AcName",
  Employee: "salesman/employee Code to Name",
  PosDiscount: "active barcode discount policies with date and branch applicability",
});

const businessRules = Object.freeze([
  "Use detail tables as the base for amount, quantity, barcode, discount, tax and stock movement.",
  "Dashboard NetAmount = Amount - all detail discounts/rounding + TaxAmt + other/delivery/alteration/stitching charges.",
  "Dashboard-compatible sales totals combine PosDetail + UnPosDetail for the requested period and do not depend on master BillStatus.",
  "Returns are already signed. Never reverse their sign unless showing an explicitly absolute return metric.",
  "For this mobile app, generic sales totals use POS + UnPOS as separate sources; do not silently deduplicate UnPos merely because PosMaster contains the same transaction number.",
  "Historical cost uses transaction-time detail PurchasePrice, never current BarcodeView PurchasePrice.",
  "Current stock = opening + purchase - purchase return - signed sales - transfer out + received transfer + IN adjustment - OUT adjustment.",
  "Stock Take is observation only and has no direct current-stock effect.",
  "Show readable names and pair monetary value with quantity when meaningful.",
  "Never infer supplier payable, targets, incentive values or undocumented joins.",
  "PosBarcodeAdjM/PosBarcodeAdjD are readable live tables, but their stock direction is undocumented; never add them to current stock without confirmed source/destination semantics.",
]);

function semanticTables() {
  return {
    ...(trainingKnowledge.tables || {}),
    ...(trainingKnowledge.undocumentedLiveTables || {}),
  };
}

function trainingContextForTables(tableNames, question = "") {
  const wanted = new Set((tableNames || []).map((name) => String(name).toLowerCase()));
  const tables = semanticTables();
  const tableBlocks = Object.entries(tables)
    .filter(([name]) => wanted.has(name.toLowerCase()))
    .map(([name, info]) => {
      const fields = (info.fields || [])
        .filter((field) => !/meaning not fully documented/i.test(String(field.status || "")))
        .map((field) => {
          const rule = String(field.rule || "").trim();
          return `${field.name}: ${field.meaning || "documented field"}${rule ? ` [${rule}]` : ""}`;
        });
      return [
        `${name}: ${info.purpose || ""}`,
        info.mainJoin ? `Join: ${info.mainJoin}` : "",
        info.stockEffect ? `Stock effect: ${info.stockEffect}` : "",
        info.importantRule ? `Rule: ${info.importantRule}` : "",
        fields.length ? `Fields: ${fields.join(" | ")}` : "",
      ].filter(Boolean).join("\n");
    });

  const relationships = (trainingKnowledge.relationships || []).filter((item) => {
    const text = `${item.From || ""} ${item.To || ""}`.toLowerCase();
    return [...wanted].some((name) => text.includes(name));
  }).map((item) => `${item.Relationship}: ${item.From} -> ${item.To}. ${item["AI Join Rule / Meaning"]}`);

  const questionWords = new Set(String(question || "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
  const coreTopics = new Set(["naming", "display", "unknown fields"]);
  const rules = (trainingKnowledge.businessRules || []).filter((item) => {
    const topic = String(item.Topic || "").toLowerCase();
    const ruleText = String(item.Rule || "").toLowerCase();
    if (topic === "sales" && (ruleText.includes("billstatus='p'") || ruleText.includes("protect against duplicate bills"))) return false;
    if (coreTopics.has(topic)) return true;
    return [...questionWords].some((word) => topic.includes(word));
  }).map((item) => `${item.Topic}: ${item.Rule} (${item["Why / Example"]})`);

  return [
    `Workbook source: ${trainingKnowledge.sourceWorkbook}. Live schema is authoritative for physical columns.`,
    tableBlocks.length ? `TABLE SEMANTICS:\n${tableBlocks.join("\n\n")}` : "",
    relationships.length ? `DOCUMENTED RELATIONSHIPS:\n${relationships.join("\n")}` : "",
    rules.length ? `RELEVANT WORKBOOK RULES:\n${rules.join("\n")}` : "",
  ].filter(Boolean).join("\n\n").slice(0, 24000);
}

function selectRelevantTables(question) {
  const text = String(question || "").toLowerCase();
  const selected = new Set(["BranchFile", "StockRoom", "BarcodeView"]);
  for (const table of allowedTables) {
    if (text.includes(table.toLowerCase())) selected.add(table);
  }
  if (/purchase return|supplier return|purchase waps/.test(text)) {
    ["PosPReturnM", "PosPReturnD", "AccountList"].forEach((x) => selected.add(x));
  } else if (/purchase|purchasing|kharid|khareed|supplier/.test(text)) {
    ["PosPurchaseM", "PosPurchaseD", "AccountList"].forEach((x) => selected.add(x));
  }
  if (/sale|sales|bill|invoice|profit|margin|discount|gst|fbr|tax|payment|cash|card|credit/.test(text)) {
    ["PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail", "PosPayment", "UnPosPayment", "Employee"].forEach((x) => selected.add(x));
  }
  if (/stock|inventory|available|on hand/.test(text)) {
    ["PosBarOpen", "PosPurchaseM", "PosPurchaseD", "PosPReturnM", "PosPReturnD", "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail", "PosTransferM", "PosTransferD", "PosStockAdjM", "PosStockAdjD"].forEach((x) => selected.add(x));
  }
  if (/transfer|transit|receive/.test(text)) ["PosTransferM", "PosTransferD"].forEach((x) => selected.add(x));
  if (/stock take|physical/.test(text)) ["PosStockTakeM", "PosStockTakeD"].forEach((x) => selected.add(x));
  if (/adjustment|stock adj/.test(text)) ["PosStockAdjM", "PosStockAdjD"].forEach((x) => selected.add(x));
  if (/barcode\s*(?:adj|adjustment|change|conversion)|barcod(e)?adj/.test(text)) {
    ["PosBarcodeAdjM", "PosBarcodeAdjD"].forEach((x) => selected.add(x));
  }
  if (/discount policy|discount compliance/.test(text)) selected.add("PosDiscount");
  if (/target|incentive/.test(text)) ["PosBranchIncentive", "PosSalesmanIncentive", "PosCategoryIncentive", "PosCategoryWiseSalesmanIncentive", "PosTargetMaster", "PosTargetDetail"].forEach((x) => selected.add(x));
  return [...selected].filter((table) => allowedTables.includes(table));
}

module.exports = {
  allowedTables,
  tablePurposes,
  businessRules,
  selectRelevantTables,
  trainingKnowledge,
  trainingContextForTables,
};
