const { sql, getPoolForTenant } = require("../config/db");

const STOCK_FILTERS = [
  "Brand", "CoBrand", "CoBrandClass", "Catagory", "SubCatagory", "Style",
  "SubStyle", "StyleClass", "SubStyle1", "SubStyle2", "Department",
  "SubDepartment", "Season", "Fabric", "FabricClass", "Color", "ColorClass",
  "Size", "Gender",
];

function normalize(value) {
  return String(value || "").replace(/-/g, "").trim();
}

function pakistanBusinessDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  return { date, sqlDate: new Date(`${date}T00:00:00.000Z`) };
}

async function executeStockReport(pool, { companyCode, userId, barcodes, designs }) {
  const { date, sqlDate } = pakistanBusinessDate();
  const request = pool.request();
  request.timeout = 120000;
  request
    .input("CompanyCode", sql.VarChar(6), companyCode)
    .input("Branch", sql.NVarChar(sql.MAX), "")
    .input("Store", sql.NVarChar(sql.MAX), "")
    .input("Startdate", sql.DateTime, sqlDate)
    .input("DateFrom", sql.DateTime, sqlDate)
    .input("DateTo", sql.DateTime, sqlDate)
    .input("Userid", sql.NVarChar(sql.MAX), String(userId || ""))
    .input("ReportType", sql.NVarChar(50), "7")
    .input("BranchOptions", sql.NVarChar(50), "0")
    .input("StoreOption", sql.NVarChar(50), "0")
    .input("ValuationMethod", sql.NVarChar(50), "4")
    .input("ReportName", sql.NVarChar(3), "004");
  STOCK_FILTERS.forEach((name) => request.input(name, sql.NVarChar(sql.MAX), ""));
  const result = await request
    .input("Barcode", sql.NVarChar(sql.MAX), barcodes.length ? `,${barcodes.join(",")},` : "")
    .input("Design", sql.NVarChar(sql.MAX), designs.length ? `,${designs.join(",")},` : "")
    .input("IncludeZeroBal", sql.VarChar(1), "Y")
    .input("BarCodeFr", sql.NVarChar(sql.MAX), "")
    .input("BarCodeTo", sql.NVarChar(sql.MAX), "")
    .input("RetailFr", sql.Float, 0)
    .input("RetailTo", sql.Float, 0)
    .input("IsNonInventory", sql.NVarChar(1), "Y")
    .execute("POSStockMovement");
  return { date, rows: result.recordset || [] };
}

async function getBranchWiseStock({ tenantId, companyCode, userId, lookup }) {
  const startedAt = Date.now();
  const pool = await getPoolForTenant(tenantId);
  const rawValue = String(lookup || "").trim();
  const normalizedValue = normalize(rawValue);

  console.log("[AI POS][Stock] Resolving live product", { tenantId, companyCode, lookup: rawValue });
  const productResult = await pool.request()
    .input("rawValue", sql.NVarChar(100), rawValue)
    .input("normalizedValue", sql.NVarChar(100), normalizedValue)
    .query(`SELECT TOP (200) BarCode, TransactionNumber, DesignNo, DesignDesc, ColorName, SizeName
      FROM dbo.BarcodeView
      WHERE LTRIM(RTRIM(BarCode)) = @rawValue
        OR REPLACE(LTRIM(RTRIM(BarCode)), '-', '') = @normalizedValue
        OR LTRIM(RTRIM(DesignNo)) = @rawValue
        OR REPLACE(LTRIM(RTRIM(DesignNo)), '-', '') = @normalizedValue
      ORDER BY CASE WHEN LTRIM(RTRIM(BarCode)) = @rawValue THEN 0 ELSE 1 END, BarCode`);
  const products = productResult.recordset || [];
  if (!products.length) {
    return { lookup: rawValue, found: false, rows: [], totalStock: 0, date: pakistanBusinessDate().date };
  }

  const isBarcode = products.some((row) => normalize(row.BarCode) === normalizedValue);
  const barcodes = [...new Set(products.map((row) => String(row.BarCode || "").trim()).filter(Boolean))];
  const designs = [...new Set(products.map((row) => String(row.TransactionNumber || "").trim()).filter(Boolean))];
  let companies = companyCode ? [companyCode] : [];
  if (!companies.length) {
    const companyResult = await pool.request().query(`SELECT DISTINCT LTRIM(RTRIM(CompanyCode)) AS CompanyCode
      FROM dbo.BranchFile
      WHERE NULLIF(LTRIM(RTRIM(CompanyCode)), '') IS NOT NULL
        AND ISNULL(BranchStatus, 'Y') = 'Y'`);
    companies = companyResult.recordset.map((row) => row.CompanyCode).filter(Boolean);
  }

  const reportRows = [];
  let reportDate = pakistanBusinessDate().date;
  for (const selectedCompany of companies) {
    console.log("[AI POS][Stock] Running POSStockMovement report", {
      tenantId, companyCode: selectedCompany, searchType: isBarcode ? "barcode" : "design",
      productCount: products.length,
    });
    const result = await executeStockReport(pool, {
      companyCode: selectedCompany,
      userId,
      barcodes: isBarcode ? barcodes : [],
      designs: isBarcode ? [] : designs,
    });
    reportDate = result.date;
    result.rows.forEach((row) => reportRows.push({ ...row, __CompanyCode: selectedCompany }));
  }

  const grouped = new Map();
  reportRows.forEach((row) => {
    const branchCode = String(row.BranchCode ?? row.Branch ?? row.BranchId ?? "").trim();
    const branchName = String((row.BranchName ?? row.BranchDesc ?? branchCode) || "Unknown branch").trim();
    const quantity = Number(row.BalQty ?? row.BalanceQty ?? row.StockQty ?? row.ClosingQty ?? 0);
    const key = `${row.__CompanyCode}|${branchCode}|${branchName}`;
    const current = grouped.get(key) || {
      companyCode: row.__CompanyCode, branchCode, branchName, stock: 0,
    };
    current.stock += Number.isFinite(quantity) ? quantity : 0;
    grouped.set(key, current);
  });
  const rows = [...grouped.values()].sort((a, b) => a.branchName.localeCompare(b.branchName));
  const totalStock = rows.reduce((sum, row) => sum + row.stock, 0);
  console.log("[AI POS][Stock] Live stock report completed", {
    tenantId, lookup: rawValue, products: products.length, procedureRows: reportRows.length,
    branches: rows.length, totalStock, durationMs: Date.now() - startedAt,
  });
  return {
    lookup: rawValue,
    found: true,
    searchType: isBarcode ? "barcode" : "design",
    date: reportDate,
    product: products[0],
    productCount: products.length,
    rows,
    totalStock,
  };
}

module.exports = { getBranchWiseStock };

