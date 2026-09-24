const { sql, getPoolForTenant } = require("../config/db");

const STOCK_FILTERS = [
  "Brand", "CoBrand", "CoBrandClass", "Catagory", "SubCatagory", "Style",
  "SubStyle", "StyleClass", "SubStyle1", "SubStyle2", "Department",
  "SubDepartment", "Season", "Fabric", "FabricClass", "Color", "ColorClass",
  "Size", "Gender",
];

const MOVEMENT_FIELDS = [
  "OpQty", "PurchaseQty", "PurchaseRQty", "StockRCQty", "StockIssQty",
  "SalesQty", "StockADJQty", "BalQty", "InTransitQty", "TotalQty",
];

function parseDateOnly(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function hasBusinessData(row) {
  return MOVEMENT_FIELDS.some((field) => {
    const value = Number(row?.[field] || 0);
    return Number.isFinite(value) && value !== 0;
  });
}

async function getStockSnapshot({ tenantId, companyCode, fromDate, toDate }) {
  const from = parseDateOnly(fromDate);
  const to = parseDateOnly(toDate);
  if (!from || !to || from > to) {
    const error = new Error("Invalid stock date range. Use YYYY-MM-DD and keep fromDate before toDate.");
    error.code = "INVALID_DATE_RANGE";
    throw error;
  }
  if (!String(companyCode || "").trim()) {
    const error = new Error("Authenticated company code is missing.");
    error.code = "COMPANY_CODE_REQUIRED";
    throw error;
  }

  const startedAt = Date.now();
  const pool = await getPoolForTenant(tenantId);
  const request = pool.request();
  request.timeout = 300000;
  request
    .input("CompanyCode", sql.VarChar(6), String(companyCode).trim())
    .input("Branch", sql.NVarChar(sql.MAX), "")
    .input("Store", sql.NVarChar(sql.MAX), "")
    .input("Startdate", sql.DateTime, from)
    .input("DateFrom", sql.DateTime, from)
    .input("DateTo", sql.DateTime, to)
    .input("Userid", sql.NVarChar(sql.MAX), "CHERRYSAPP")
    .input("ReportType", sql.NVarChar(50), "7")
    .input("BranchOptions", sql.NVarChar(50), "1")
    .input("StoreOption", sql.NVarChar(50), "1")
    .input("ValuationMethod", sql.NVarChar(50), "3")
    .input("ReportName", sql.NVarChar(3), "004");

  STOCK_FILTERS.forEach((name) => request.input(name, sql.NVarChar(sql.MAX), ""));
  const result = await request
    .input("Barcode", sql.NVarChar(sql.MAX), "")
    .input("Design", sql.NVarChar(sql.MAX), "")
    .input("IncludeZeroBal", sql.VarChar(1), "Y")
    .input("BarCodeFr", sql.NVarChar(sql.MAX), "")
    .input("BarCodeTo", sql.NVarChar(sql.MAX), "")
    .input("RetailFr", sql.Float, 0)
    .input("RetailTo", sql.Float, 0)
    .input("IsNonInventory", sql.NVarChar(1), "Y")
    .execute("dbo.POSStockMovement");

  const rawRows = result.recordset || [];
  const rows = rawRows.filter(hasBusinessData);
  console.log("[StockSnapshot] Completed", {
    tenantId,
    companyCode,
    fromDate,
    toDate,
    procedureRows: rawRows.length,
    usefulRows: rows.length,
    durationMs: Date.now() - startedAt,
  });
  return { rows, procedureRows: rawRows.length, durationMs: Date.now() - startedAt };
}

module.exports = { getStockSnapshot, parseDateOnly, hasBusinessData };
