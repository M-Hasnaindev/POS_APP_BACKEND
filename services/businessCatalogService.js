const catalog = require("../ai/businessReportCatalog.json");

const byCode = new Map(catalog.map((item) => [item.code.toLowerCase(), item]));

const BUSINESS_RULES = Object.freeze({
  detailFirst: "Amounts, quantities, item values, cost, discount and tax come from detail tables. Headers only supply dates, status, branch and party context.",
  paidSales: "Use PosDetail + PosMaster and UnPosDetail + UnPosMaster. Require BillStatus='P', exclude detail Cancel='Y', and de-duplicate UnPos rows already closed in PosMaster.",
  signedReturns: "Sales return quantities and amounts are already negative and must not be reversed again.",
  historicalCost: "Historical profit uses transaction-time PurchasePrice from the sales detail, never the current BarcodeView price.",
  currentStock: "Opening + Purchase - Purchase Return - signed Sales - Transfer Out + received Transfer In + IN adjustments - OUT adjustments.",
  stockTake: "Stock Take is a physical comparison only and does not change stock by itself.",
  readableNames: "Join BranchFile, StockRoom, BarcodeView, AccountList and Employee so people see names together with codes.",
});

const METRICS = Object.freeze({
  netSales: { label:"Net Sales", expression:"SUM(signed detail NetAmount or documented allocated paid value)", facts:["PosDetail","UnPosDetail"] },
  netQuantity: { label:"Net Quantity", expression:"SUM(signed detail Quantity)", facts:["PosDetail","UnPosDetail"] },
  grossProfit: { label:"Gross Profit", expression:"Net sales - SUM(signed Quantity * transaction-time PurchasePrice)", facts:["PosDetail","UnPosDetail"] },
  marginPercent: { label:"Margin %", expression:"Gross Profit / Net Sales * 100", facts:["PosDetail","UnPosDetail"] },
  purchase: { label:"Purchase", expression:"SUM(PosPurchaseD final documented detail amount and Quantity)", facts:["PosPurchaseD","PosPurchaseM"] },
  currentStock: { label:"Current Stock", expression:BUSINESS_RULES.currentStock, facts:["PosBarOpen","PosPurchaseD","PosPReturnD","PosDetail","UnPosDetail","PosTransferD","PosStockAdjD"] },
});

const RELATIONSHIPS = Object.freeze([
  "PosDetail.TransactionNumber = PosMaster.TransactionNumber",
  "UnPosDetail.TransactionNumber = UnPosMaster.TransactionNumber",
  "PosPurchaseD.TransactionNumber = PosPurchaseM.TransactionNumber",
  "PosPReturnD.TransactionNumber = PosPReturnM.TransactionNumber",
  "PosTransferD.TransactionNumber = PosTransferM.TransactionNumber",
  "detail.BarCode = BarcodeView.BarCode",
  "transaction branch code = BranchFile.BranchCode",
  "store code = StockRoom.Code",
  "party/account code = AccountList.ActCod",
  "salesman code = Employee.Code",
]);

function listReports() {
  const groups = new Map();
  for (const report of catalog) {
    const list = groups.get(report.category) || [];
    list.push(report);
    groups.set(report.category, list);
  }
  return {
    count: catalog.length,
    categories: [...groups.entries()].map(([name, reports], order) => ({ order: order + 1, name, count: reports.length, reports })),
  };
}

function getReport(code) {
  const report = byCode.get(String(code || "").trim().toLowerCase());
  if (!report) throw Object.assign(new Error("Report definition was not found"), { status: 404 });
  return report;
}

function semanticContext() {
  return { rules: BUSINESS_RULES, metrics:METRICS, relationships:RELATIONSHIPS, allowedTables: require("./knowledgeResourceService").APPROVED_TABLES };
}

module.exports = { BUSINESS_RULES, METRICS, RELATIONSHIPS, getReport, listReports, semanticContext };
