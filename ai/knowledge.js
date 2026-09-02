const allowedTables = Object.freeze([
  "BranchFile", "StockRoom", "BarcodeView", "AccountList", "Employee", "Defaults",
  "PosMaster", "PosDetail", "PosPayment", "UnPosMaster", "UnPosDetail", "UnPosPayment",
  "PosPurchaseM", "PosPurchaseD", "PosPReturnM", "PosPReturnD",
  "PosTransferM", "PosTransferD", "PosBarOpen",
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
  "Paid sales require matching master BillStatus='P'; exclude detail Cancel='Y'.",
  "Returns are already signed. Never reverse their sign unless showing an explicitly absolute return metric.",
  "When combining UnPos and Pos, exclude a paid UnPos bill already present as paid in PosMaster.",
  "Historical cost uses transaction-time detail PurchasePrice, never current BarcodeView PurchasePrice.",
  "Current stock = opening + purchase - purchase return - signed sales - transfer out + received transfer + IN adjustment - OUT adjustment.",
  "Stock Take is observation only and has no direct current-stock effect.",
  "Show readable names and pair monetary value with quantity when meaningful.",
  "Never infer supplier payable, targets, incentive values or undocumented joins.",
]);

function selectRelevantTables(question) {
  const text = String(question || "").toLowerCase();
  const selected = new Set(["BranchFile", "StockRoom", "BarcodeView"]);
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
  if (/discount policy|discount compliance/.test(text)) selected.add("PosDiscount");
  if (/target|incentive/.test(text)) ["PosBranchIncentive", "PosSalesmanIncentive", "PosCategoryIncentive", "PosCategoryWiseSalesmanIncentive", "PosTargetMaster", "PosTargetDetail"].forEach((x) => selected.add(x));
  return [...selected].filter((table) => allowedTables.includes(table));
}

module.exports = { allowedTables, tablePurposes, businessRules, selectRelevantTables };
