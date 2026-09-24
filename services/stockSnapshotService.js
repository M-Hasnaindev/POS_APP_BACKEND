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

async function resolveCompanyCode(pool, { companyCode, requestedCompanyCode, userId }) {
  const tokenCompany = String(companyCode || "").trim();
  if (tokenCompany) return tokenCompany;

  const requested = String(requestedCompanyCode || "").trim();
  const request = pool.request().input("userId", sql.VarChar, String(userId || "").trim());
  let query = `SELECT DISTINCT LTRIM(RTRIM(CompanyCode)) AS CompanyCode
    FROM dbo.Security
    WHERE LTRIM(RTRIM(UserID)) = LTRIM(RTRIM(@userId))
      AND NULLIF(LTRIM(RTRIM(CompanyCode)), '') IS NOT NULL`;
  if (requested) {
    request.input("requestedCompanyCode", sql.VarChar(20), requested);
    query += " AND LTRIM(RTRIM(CompanyCode)) = @requestedCompanyCode";
  }
  const result = await request.query(query);
  const companies = (result.recordset || []).map((row) => String(row.CompanyCode || "").trim()).filter(Boolean);
  if (companies.length === 1) return companies[0];

  // Older persisted sessions can contain a valid tenant/user token but no
  // company claim (and some admin Security rows do not carry CompanyCode).
  // Resolve against the already-authenticated tenant database. A requested
  // value is accepted only when it actually exists in BranchFile; without a
  // requested value we proceed only when that tenant database has one company.
  const branchRequest = pool.request();
  let branchQuery = `SELECT DISTINCT LTRIM(RTRIM(CompanyCode)) AS CompanyCode
    FROM dbo.BranchFile
    WHERE NULLIF(LTRIM(RTRIM(CompanyCode)), '') IS NOT NULL`;
  if (requested) {
    branchRequest.input("requestedCompanyCode", sql.VarChar(20), requested);
    branchQuery += " AND LTRIM(RTRIM(CompanyCode)) = @requestedCompanyCode";
  }
  const branchResult = await branchRequest.query(branchQuery);
  const tenantCompanies = (branchResult.recordset || [])
    .map((row) => String(row.CompanyCode || "").trim())
    .filter(Boolean);
  if (tenantCompanies.length === 1) return tenantCompanies[0];

  const error = new Error(
    companies.length > 1 || tenantCompanies.length > 1
      ? "Company selection is required. Please sign in again."
      : "Authenticated company could not be verified. Please sign in again.",
  );
  error.code = "COMPANY_CODE_REQUIRED";
  throw error;
}

async function getStockSnapshot({ tenantId, companyCode, requestedCompanyCode, userId, fromDate, toDate }) {
  const from = parseDateOnly(fromDate);
  const to = parseDateOnly(toDate);
  if (!from || !to || from > to) {
    const error = new Error("Invalid stock date range. Use YYYY-MM-DD and keep fromDate before toDate.");
    error.code = "INVALID_DATE_RANGE";
    throw error;
  }
  const startedAt = Date.now();
  const pool = await getPoolForTenant(tenantId);
  const effectiveCompanyCode = await resolveCompanyCode(pool, {
    companyCode,
    requestedCompanyCode,
    userId,
  });
  const request = pool.request();
  request.timeout = 300000;
  request
    .input("CompanyCode", sql.VarChar(6), effectiveCompanyCode)
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
    companyCode: effectiveCompanyCode,
    fromDate,
    toDate,
    procedureRows: rawRows.length,
    usefulRows: rows.length,
    durationMs: Date.now() - startedAt,
  });
  return { rows, procedureRows: rawRows.length, durationMs: Date.now() - startedAt };
}

module.exports = { getStockSnapshot, parseDateOnly, hasBusinessData, resolveCompanyCode };
