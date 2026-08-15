// ============================================
// SALES CONTROLLER - UPDATED WITH FIXES
// ============================================
// FIXES APPLIED:
// 1. getSalesReport → COMPLETE LAST YEAR (12 MONTHS) instead of 2 months
// 2. getBarcodes → LAST YEAR + CURRENT YEAR (100K+ records) instead of current year only
// ============================================

const { sql, pool } = require("../config/db");

// ============================================
// 1. SALES REPORT API - COMPLETE LAST YEAR (12 MONTHS) - FIX APPLIED
// Used by: Config Screen (FAST sync)
// Saves to: SalesReportTemp table
// FIX: Changed from 2 months to COMPLETE LAST YEAR
// ============================================
const getSalesReport = async (req, res) => {
  try {
    const connection = await pool;

    // DATE RANGE: COMPLETE LAST YEAR (12 MONTHS) - FIX APPLIED
    const now = new Date();
    
    // FIX: Calculate one year ago from current month
    const oneYearAgo = new Date(now.getFullYear() - 1, now.getMonth(), 1);

    const fromDateStr = oneYearAgo.toISOString().split("T")[0] + " 00:00:00.000";
    const toDateStr = now.toISOString().split("T")[0] + " 23:59:59.999";

    console.log("📊 SALES REPORT (COMPLETE LAST YEAR - 12 MONTHS) - Date Range:", fromDateStr, "→", toDateStr);

    const query = `
-------------------------------
-- UnPosDetail (LAST YEAR - 12 MONTHS) - FIX APPLIED
-------------------------------
SELECT 
  A.TransactionNumber AS BillNo,
  A.TranDate AS BillDate,
  CAST(B.EntryDate AS TIME) AS Time,
  A.CompanyCode,
  A.Branch,
  A.StoreCode AS Location,
  A.BarCode,
  A.SalesManAccount AS SalesMan,
  CASE WHEN A.SalesType = 'S' THEN 'Sale' ELSE 'Return' END AS SaleorReturn,

  SUM(ISNULL(A.Quantity,0)) AS Qty,
  SUM(ISNULL(A.Amount,0)) AS RetailExclGST,

  ISNULL(A.DiscPerAuto,0) AS BarcodeDiscPer,
  SUM(ISNULL(A.DiscAutoAmt,0)) AS BarcodeDiscount,
  ISNULL(A.DiscPerManual,0) AS ManualDiscPer,
  SUM(ISNULL(A.DiscManualAmt,0)) AS ManualDiscount,

  SUM(ISNULL(A.DetSchemeDisc,0)) AS SchemeDiscount,
  SUM(ISNULL(A.DetLoyalityDisc,0)) AS LoyalityDiscount,
  SUM(ISNULL(A.DetBillDiscAmt,0)) AS BillDiscount,
  SUM(ISNULL(A.DetRoundingAmt,0)) AS RoundingDiscount,

  SUM(ISNULL(A.DiscAutoAmt,0)) + 
  SUM(ISNULL(A.DiscManualAmt,0)) + 
  SUM(ISNULL(A.DetSchemeDisc,0)) + 
  SUM(ISNULL(A.DetLoyalityDisc,0)) + 
  SUM(ISNULL(A.DetBillDiscAmt,0)) + 
  SUM(ISNULL(A.DetRoundingAmt,0)) AS TotalDiscount,

  SUM(ISNULL(A.Amount,0)) 
  - SUM(ISNULL(A.DiscAutoAmt,0))
  - SUM(ISNULL(A.DiscManualAmt,0))
  - SUM(ISNULL(A.DetSchemeDisc,0))
  - SUM(ISNULL(A.DetLoyalityDisc,0))
  - SUM(ISNULL(A.DetBillDiscAmt,0))
  - SUM(ISNULL(A.DetRoundingAmt,0)) AS NetSalesExclGST,

  ISNULL(A.TaxPer,0) AS GSTP,
  SUM(ISNULL(A.TaxAmt,0)) AS GST,

  SUM(ISNULL(A.Amount,0)) 
  - SUM(ISNULL(A.DiscAutoAmt,0))
  - SUM(ISNULL(A.DiscManualAmt,0))
  - SUM(ISNULL(A.DetSchemeDisc,0))
  - SUM(ISNULL(A.DetLoyalityDisc,0))
  - SUM(ISNULL(A.DetBillDiscAmt,0))
  - SUM(ISNULL(A.DetRoundingAmt,0))
  + SUM(ISNULL(A.TaxAmt,0))
  + (SUM(ISNULL(DetOthCharges,0)) + SUM(ISNULL(DetDelCharges,0)) + SUM(ISNULL(DetAltCharges,0)) + SUM(ISNULL(DetStitchCharges,0))) AS NetAmount,

  ISNULL(A.CostPrice,0) AS CostPrice,
  SUM(ISNULL(A.CostPrice,0) * ISNULL(A.Quantity,0)) AS CostAmountofSales,

  ISNULL(A.PurchasePrice,0) AS PurchasePrice,
  SUM(ISNULL(A.PurchasePrice,0) * ISNULL(A.Quantity,0)) AS PurchaseAmountofSales,

  ISNULL(A.WholesalePrice,0) AS WholeSalesPrice,
  SUM(ISNULL(A.WholesalePrice,0) * ISNULL(A.Quantity,0)) AS WholesalesAmountofSales,

  ISNULL(A.RetailPrice,0) AS RetailPriceInclGST,
  SUM(ISNULL(A.RetailPrice,0) * ISNULL(A.Quantity,0)) AS RetailSalesInclGST,

  (SUM(ISNULL(DetOthCharges,0)) + SUM(ISNULL(DetDelCharges,0)) + SUM(ISNULL(DetAltCharges,0)) + SUM(ISNULL(DetStitchCharges,0))) AS TotalCharges,

  SUM(ISNULL(DetPaidCash,0)) AS PaidCash,
  SUM(ISNULL(DetPaidCard,0)) AS PaidCard,
  SUM(ISNULL(DetPaidCredit,0)) AS PaidCredit,
  SUM(ISNULL(SalesmanAmt,0)) AS SalesmanAmt

FROM UnPosDetail A
LEFT JOIN UnPosMaster B 
  ON A.CompanyCode = B.CompanyCode 
  AND A.Branch = B.Branch 
  AND A.TransactionNumber = B.TransactionNumber

WHERE 
  A.TranDate BETWEEN '${fromDateStr}' AND '${toDateStr}'

GROUP BY 
  A.TransactionNumber, A.TranDate, B.EntryDate,
  A.CompanyCode, A.Branch, A.StoreCode, A.BarCode, A.SalesManAccount,
  A.SalesType,
  ISNULL(A.DiscPerAuto,0), ISNULL(A.DiscPerManual,0),
  ISNULL(A.TaxPer,0), ISNULL(A.CostPrice,0), ISNULL(A.PurchasePrice,0),
  ISNULL(A.WholesalePrice,0), ISNULL(A.RetailPrice,0)

UNION ALL

-------------------------------
-- PosDetail (LAST YEAR - 12 MONTHS) - FIX APPLIED
-------------------------------
SELECT 
  A.TransactionNumber AS BillNo,
  A.TranDate AS BillDate,
  CAST(B.EntryDate AS TIME) AS Time,
  A.CompanyCode,
  A.Branch,
  A.StoreCode AS Location,
  A.BarCode,
  A.SalesManAccount AS SalesMan,
  CASE WHEN A.SalesType = 'S' THEN 'Sale' ELSE 'Return' END AS SaleorReturn,

  SUM(ISNULL(A.Quantity,0)) AS Qty,
  SUM(ISNULL(A.Amount,0)) AS RetailExclGST,

  ISNULL(A.DiscPerAuto,0) AS BarcodeDiscPer,
  SUM(ISNULL(A.DiscAutoAmt,0)) AS BarcodeDiscount,
  ISNULL(A.DiscPerManual,0) AS ManualDiscPer,
  SUM(ISNULL(A.DiscManualAmt,0)) AS ManualDiscount,

  SUM(ISNULL(A.DetSchemeDisc,0)) AS SchemeDiscount,
  SUM(ISNULL(A.DetLoyalityDisc,0)) AS LoyalityDiscount,
  SUM(ISNULL(A.DetBillDiscAmt,0)) AS BillDiscount,
  SUM(ISNULL(A.DetRoundingAmt,0)) AS RoundingDiscount,

  SUM(ISNULL(A.DiscAutoAmt,0)) + 
  SUM(ISNULL(A.DiscManualAmt,0)) + 
  SUM(ISNULL(A.DetSchemeDisc,0)) + 
  SUM(ISNULL(A.DetLoyalityDisc,0)) + 
  SUM(ISNULL(A.DetBillDiscAmt,0)) + 
  SUM(ISNULL(A.DetRoundingAmt,0)) AS TotalDiscount,

  SUM(ISNULL(A.Amount,0)) 
  - SUM(ISNULL(A.DiscAutoAmt,0))
  - SUM(ISNULL(A.DiscManualAmt,0))
  - SUM(ISNULL(A.DetSchemeDisc,0))
  - SUM(ISNULL(A.DetLoyalityDisc,0))
  - SUM(ISNULL(A.DetBillDiscAmt,0))
  - SUM(ISNULL(A.DetRoundingAmt,0)) AS NetSalesExclGST,

  ISNULL(A.TaxPer,0) AS GSTP,
  SUM(ISNULL(A.TaxAmt,0)) AS GST,

  SUM(ISNULL(A.Amount,0)) 
  - SUM(ISNULL(A.DiscAutoAmt,0))
  - SUM(ISNULL(A.DiscManualAmt,0))
  - SUM(ISNULL(A.DetSchemeDisc,0))
  - SUM(ISNULL(A.DetLoyalityDisc,0))
  - SUM(ISNULL(A.DetBillDiscAmt,0))
  - SUM(ISNULL(A.DetRoundingAmt,0))
  + SUM(ISNULL(A.TaxAmt,0))
  + (SUM(ISNULL(DetOthCharges,0)) + SUM(ISNULL(DetDelCharges,0)) + SUM(ISNULL(DetAltCharges,0)) + SUM(ISNULL(DetStitchCharges,0))) AS NetAmount,

  ISNULL(A.CostPrice,0) AS CostPrice,
  SUM(ISNULL(A.CostPrice,0) * ISNULL(A.Quantity,0)) AS CostAmountofSales,

  ISNULL(A.PurchasePrice,0) AS PurchasePrice,
  SUM(ISNULL(A.PurchasePrice,0) * ISNULL(A.Quantity,0)) AS PurchaseAmountofSales,

  ISNULL(A.WholesalePrice,0) AS WholeSalesPrice,
  SUM(ISNULL(A.WholesalePrice,0) * ISNULL(A.Quantity,0)) AS WholesalesAmountofSales,

  ISNULL(A.RetailPrice,0) AS RetailPriceInclGST,
  SUM(ISNULL(A.RetailPrice,0) * ISNULL(A.Quantity,0)) AS RetailSalesInclGST,

  (SUM(ISNULL(DetOthCharges,0)) + SUM(ISNULL(DetDelCharges,0)) + SUM(ISNULL(DetAltCharges,0)) + SUM(ISNULL(DetStitchCharges,0))) AS TotalCharges,

  SUM(ISNULL(DetPaidCash,0)) AS PaidCash,
  SUM(ISNULL(DetPaidCard,0)) AS PaidCard,
  SUM(ISNULL(DetPaidCredit,0)) AS PaidCredit,
  SUM(ISNULL(SalesmanAmt,0)) AS SalesmanAmt

FROM PosDetail A
LEFT JOIN PosMaster B 
  ON A.CompanyCode = B.CompanyCode 
  AND A.Branch = B.Branch 
  AND A.TransactionNumber = B.TransactionNumber

WHERE 
  A.TranDate BETWEEN '${fromDateStr}' AND '${toDateStr}'

GROUP BY 
  A.TransactionNumber, A.TranDate, B.EntryDate,
  A.CompanyCode, A.Branch, A.StoreCode, A.BarCode, A.SalesManAccount,
  A.SalesType,
  ISNULL(A.DiscPerAuto,0), ISNULL(A.DiscPerManual,0),
  ISNULL(A.TaxPer,0), ISNULL(A.CostPrice,0), ISNULL(A.PurchasePrice,0),
  ISNULL(A.WholesalePrice,0), ISNULL(A.RetailPrice,0)

ORDER BY BillDate DESC
`;

    const result = await connection.request().query(query);

    console.log("✅ SALES REPORT returned:", result.recordset.length, "records (COMPLETE LAST YEAR - 12 MONTHS)");

    res.json({
      success: true,
      data: result.recordset,
      count: result.recordset.length,
      dateRange: { from: fromDateStr, to: toDateStr },
    });

  } catch (error) {
    console.log("❌ SALES REPORT ERROR:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
};

// ============================================
// 2. SALES REPORT ALL - ALL HISTORICAL DATA (WITH PAGINATION) - UNCHANGED
// Used by: Background Sync (after Home loads)
// Saves to: SalesTable (POS_sales)
// ============================================
const getSalesReportAll = async (req, res) => {
  try {
    const connection = await pool;

    const { fromDate, toDate, page, pageSize } = req.query;

    const currentPage = parseInt(page) || 1;
    const recordsPerPage = Math.min(parseInt(pageSize) || 5000, 10000);
    const offset = (currentPage - 1) * recordsPerPage;

    console.log(`📊 SALES REPORT ALL - Page ${currentPage}, PageSize ${recordsPerPage}, Offset ${offset}`);

    let dateCondition = "";
    if (fromDate && toDate) {
      dateCondition = `A.TranDate BETWEEN '${fromDate}' AND '${toDate}' AND`;
    } else if (fromDate) {
      const currentDate = new Date().toISOString().split('T')[0] + ' 23:59:59.999';
      dateCondition = `A.TranDate BETWEEN '${fromDate}' AND '${currentDate}' AND`;
    }

    console.log("📊 SALES REPORT ALL (HISTORICAL) - Date Condition:", dateCondition || "ALL TIME");

    const query = `
-------------------------------
-- UnPosDetail (ALL DATA)
-------------------------------
SELECT 
  A.TransactionNumber AS BillNo,
  A.TranDate AS BillDate,
  CAST(B.EntryDate AS TIME) AS Time,
  A.CompanyCode,
  A.Branch,
  A.StoreCode AS Location,
  A.BarCode,
  A.SalesManAccount AS SalesMan,
  CASE WHEN A.SalesType = 'S' THEN 'Sale' ELSE 'Return' END AS SaleorReturn,

  SUM(ISNULL(A.Quantity,0)) AS Qty,
  SUM(ISNULL(A.Amount,0)) AS RetailExclGST,

  ISNULL(A.DiscPerAuto,0) AS BarcodeDiscPer,
  SUM(ISNULL(A.DiscAutoAmt,0)) AS BarcodeDiscount,
  ISNULL(A.DiscPerManual,0) AS ManualDiscPer,
  SUM(ISNULL(A.DiscManualAmt,0)) AS ManualDiscount,

  SUM(ISNULL(A.DetSchemeDisc,0)) AS SchemeDiscount,
  SUM(ISNULL(A.DetLoyalityDisc,0)) AS LoyalityDiscount,
  SUM(ISNULL(A.DetBillDiscAmt,0)) AS BillDiscount,
  SUM(ISNULL(A.DetRoundingAmt,0)) AS RoundingDiscount,

  SUM(ISNULL(A.DiscAutoAmt,0)) + 
  SUM(ISNULL(A.DiscManualAmt,0)) + 
  SUM(ISNULL(A.DetSchemeDisc,0)) + 
  SUM(ISNULL(A.DetLoyalityDisc,0)) + 
  SUM(ISNULL(A.DetBillDiscAmt,0)) + 
  SUM(ISNULL(A.DetRoundingAmt,0)) AS TotalDiscount,

  SUM(ISNULL(A.Amount,0)) 
  - SUM(ISNULL(A.DiscAutoAmt,0))
  - SUM(ISNULL(A.DiscManualAmt,0))
  - SUM(ISNULL(A.DetSchemeDisc,0))
  - SUM(ISNULL(A.DetLoyalityDisc,0))
  - SUM(ISNULL(A.DetBillDiscAmt,0))
  - SUM(ISNULL(A.DetRoundingAmt,0)) AS NetSalesExclGST,

  ISNULL(A.TaxPer,0) AS GSTP,
  SUM(ISNULL(A.TaxAmt,0)) AS GST,

  SUM(ISNULL(A.Amount,0)) 
  - SUM(ISNULL(A.DiscAutoAmt,0))
  - SUM(ISNULL(A.DiscManualAmt,0))
  - SUM(ISNULL(A.DetSchemeDisc,0))
  - SUM(ISNULL(A.DetLoyalityDisc,0))
  - SUM(ISNULL(A.DetBillDiscAmt,0))
  - SUM(ISNULL(A.DetRoundingAmt,0))
  + SUM(ISNULL(A.TaxAmt,0))
  + (SUM(ISNULL(DetOthCharges,0)) + SUM(ISNULL(DetDelCharges,0)) + SUM(ISNULL(DetAltCharges,0)) + SUM(ISNULL(DetStitchCharges,0))) AS NetAmount,

  ISNULL(A.CostPrice,0) AS CostPrice,
  SUM(ISNULL(A.CostPrice,0) * ISNULL(A.Quantity,0)) AS CostAmountofSales,

  ISNULL(A.PurchasePrice,0) AS PurchasePrice,
  SUM(ISNULL(A.PurchasePrice,0) * ISNULL(A.Quantity,0)) AS PurchaseAmountofSales,

  ISNULL(A.WholesalePrice,0) AS WholeSalesPrice,
  SUM(ISNULL(A.WholesalePrice,0) * ISNULL(A.Quantity,0)) AS WholesalesAmountofSales,

  ISNULL(A.RetailPrice,0) AS RetailPriceInclGST,
  SUM(ISNULL(A.RetailPrice,0) * ISNULL(A.Quantity,0)) AS RetailSalesInclGST,

  (SUM(ISNULL(DetOthCharges,0)) + SUM(ISNULL(DetDelCharges,0)) + SUM(ISNULL(DetAltCharges,0)) + SUM(ISNULL(DetStitchCharges,0))) AS TotalCharges,

  SUM(ISNULL(DetPaidCash,0)) AS PaidCash,
  SUM(ISNULL(DetPaidCard,0)) AS PaidCard,
  SUM(ISNULL(DetPaidCredit,0)) AS PaidCredit,
  SUM(ISNULL(SalesmanAmt,0)) AS SalesmanAmt,

  MAX(LastEditDate) AS LastEditDate

FROM UnPosDetail A
LEFT JOIN UnPosMaster B 
  ON A.CompanyCode = B.CompanyCode 
  AND A.Branch = B.Branch 
  AND A.TransactionNumber = B.TransactionNumber

WHERE 
  ${dateCondition}
  Isnull(A.Cancel,'N') != 'Y'
  AND A.CompanyCode = B.CompanyCode 
  AND A.Branch = B.Branch 
  AND A.TransactionNumber = B.TransactionNumber

GROUP BY 
  A.TransactionNumber, A.TranDate, B.EntryDate,
  A.CompanyCode, A.Branch, A.StoreCode, A.BarCode, A.SalesManAccount,
  A.SalesType,
  ISNULL(A.DiscPerAuto,0), ISNULL(A.DiscPerManual,0),
  ISNULL(A.TaxPer,0), ISNULL(A.CostPrice,0), ISNULL(A.PurchasePrice,0),
  ISNULL(A.WholesalePrice,0), ISNULL(A.RetailPrice,0)

UNION ALL

-------------------------------
-- PosDetail (ALL DATA)
-------------------------------
SELECT 
  A.TransactionNumber AS BillNo,
  A.TranDate AS BillDate,
  CAST(B.EntryDate AS TIME) AS Time,
  A.CompanyCode,
  A.Branch,
  A.StoreCode AS Location,
  A.BarCode,
  A.SalesManAccount AS SalesMan,
  CASE WHEN A.SalesType = 'S' THEN 'Sale' ELSE 'Return' END AS SaleorReturn,

  SUM(ISNULL(A.Quantity,0)) AS Qty,
  SUM(ISNULL(A.Amount,0)) AS RetailExclGST,

  ISNULL(A.DiscPerAuto,0) AS BarcodeDiscPer,
  SUM(ISNULL(A.DiscAutoAmt,0)) AS BarcodeDiscount,
  ISNULL(A.DiscPerManual,0) AS ManualDiscPer,
  SUM(ISNULL(A.DiscManualAmt,0)) AS ManualDiscount,

  SUM(ISNULL(A.DetSchemeDisc,0)) AS SchemeDiscount,
  SUM(ISNULL(A.DetLoyalityDisc,0)) AS LoyalityDiscount,
  SUM(ISNULL(A.DetBillDiscAmt,0)) AS BillDiscount,
  SUM(ISNULL(A.DetRoundingAmt,0)) AS RoundingDiscount,

  SUM(ISNULL(A.DiscAutoAmt,0)) + 
  SUM(ISNULL(A.DiscManualAmt,0)) + 
  SUM(ISNULL(A.DetSchemeDisc,0)) + 
  SUM(ISNULL(A.DetLoyalityDisc,0)) + 
  SUM(ISNULL(A.DetBillDiscAmt,0)) + 
  SUM(ISNULL(A.DetRoundingAmt,0)) AS TotalDiscount,

  SUM(ISNULL(A.Amount,0)) 
  - SUM(ISNULL(A.DiscAutoAmt,0))
  - SUM(ISNULL(A.DiscManualAmt,0))
  - SUM(ISNULL(A.DetSchemeDisc,0))
  - SUM(ISNULL(A.DetLoyalityDisc,0))
  - SUM(ISNULL(A.DetBillDiscAmt,0))
  - SUM(ISNULL(A.DetRoundingAmt,0)) AS NetSalesExclGST,

  ISNULL(A.TaxPer,0) AS GSTP,
  SUM(ISNULL(A.TaxAmt,0)) AS GST,

  SUM(ISNULL(A.Amount,0)) 
  - SUM(ISNULL(A.DiscAutoAmt,0))
  - SUM(ISNULL(A.DiscManualAmt,0))
  - SUM(ISNULL(A.DetSchemeDisc,0))
  - SUM(ISNULL(A.DetLoyalityDisc,0))
  - SUM(ISNULL(A.DetBillDiscAmt,0))
  - SUM(ISNULL(A.DetRoundingAmt,0))
  + SUM(ISNULL(A.TaxAmt,0))
  + (SUM(ISNULL(DetOthCharges,0)) + SUM(ISNULL(DetDelCharges,0)) + SUM(ISNULL(DetAltCharges,0)) + SUM(ISNULL(DetStitchCharges,0))) AS NetAmount,

  ISNULL(A.CostPrice,0) AS CostPrice,
  SUM(ISNULL(A.CostPrice,0) * ISNULL(A.Quantity,0)) AS CostAmountofSales,

  ISNULL(A.PurchasePrice,0) AS PurchasePrice,
  SUM(ISNULL(A.PurchasePrice,0) * ISNULL(A.Quantity,0)) AS PurchaseAmountofSales,

  ISNULL(A.WholesalePrice,0) AS WholeSalesPrice,
  SUM(ISNULL(A.WholesalePrice,0) * ISNULL(A.Quantity,0)) AS WholesalesAmountofSales,

  ISNULL(A.RetailPrice,0) AS RetailPriceInclGST,
  SUM(ISNULL(A.RetailPrice,0) * ISNULL(A.Quantity,0)) AS RetailSalesInclGST,

  (SUM(ISNULL(DetOthCharges,0)) + SUM(ISNULL(DetDelCharges,0)) + SUM(ISNULL(DetAltCharges,0)) + SUM(ISNULL(DetStitchCharges,0))) AS TotalCharges,

  SUM(ISNULL(DetPaidCash,0)) AS PaidCash,
  SUM(ISNULL(DetPaidCard,0)) AS PaidCard,
  SUM(ISNULL(DetPaidCredit,0)) AS PaidCredit,
  SUM(ISNULL(SalesmanAmt,0)) AS SalesmanAmt,

  MAX(LastEditDate) AS LastEditDate

FROM PosDetail A
LEFT JOIN PosMaster B 
  ON A.CompanyCode = B.CompanyCode 
  AND A.Branch = B.Branch 
  AND A.TransactionNumber = B.TransactionNumber

WHERE 
  ${dateCondition}
  Isnull(A.Cancel,'N') != 'Y'
  And A.CompanyCode = B.CompanyCode 
  AND A.Branch = B.Branch 
  AND A.TransactionNumber = B.TransactionNumber

GROUP BY 
  A.TransactionNumber, A.TranDate, B.EntryDate,
  A.CompanyCode, A.Branch, A.StoreCode, A.BarCode, A.SalesManAccount,
  A.SalesType,
  ISNULL(A.DiscPerAuto,0), ISNULL(A.DiscPerManual,0),
  ISNULL(A.TaxPer,0), ISNULL(A.CostPrice,0), ISNULL(A.PurchasePrice,0),
  ISNULL(A.WholesalePrice,0), ISNULL(A.RetailPrice,0)

ORDER BY BillDate DESC, BillNo
OFFSET ${offset} ROWS
FETCH NEXT ${recordsPerPage + 1} ROWS ONLY
`;

    const result = await connection.request().query(query);

    const hasMore = result.recordset.length > recordsPerPage;
    const actualData = hasMore ? result.recordset.slice(0, recordsPerPage) : result.recordset;

    console.log(`✅ SALES REPORT ALL - Page ${currentPage} returned: ${actualData.length} records, hasMore: ${hasMore}`);

    res.json({ 
      success: true, 
      data: actualData,
      count: actualData.length,
      page: currentPage,
      pageSize: recordsPerPage,
      hasMore: hasMore,
      dateRange: {
        from: fromDate || "All time",
        to: toDate || "Current date"
      }
    });

  } catch (error) {
    console.log("❌ SALES REPORT ALL ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// 2b. SALES REPORT COUNT - UNCHANGED
// ============================================
const getSalesReportCount = async (req, res) => {
  try {
    const connection = await pool;

    console.log("📊 SALES REPORT COUNT - Calculating...");

    const query = `
SELECT 
  (SELECT COUNT(*) FROM UnPosDetail) + 
  (SELECT COUNT(*) FROM PosDetail) AS TotalCount
`;

    const result = await connection.request().query(query);
    const totalCount = result.recordset[0]?.TotalCount || 0;

    console.log("✅ SALES REPORT COUNT:", totalCount);

    res.json({ 
      success: true, 
      count: totalCount,
      total: totalCount
    });

  } catch (error) {
    console.log("❌ SALES REPORT COUNT ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// 3. BARCODES API - LAST YEAR + CURRENT YEAR - FIX APPLIED
// FIX: Changed from current year only to LAST YEAR + CURRENT YEAR
// Returns: 100K+ records properly
// ============================================
const getBarcodes = async (req, res) => {
  try {
    const connection = await pool;

    const page = parseInt(req.query.page);
    const pageSize = parseInt(req.query.pageSize);
    const offset = (page - 1) * pageSize;

    console.log(`📊 BARCODES API - Page: ${page}, Size: ${pageSize}`);

    // FIX: Calculate last year for filtering
    const currentYear = new Date().getFullYear();
    const lastYear = currentYear - 1;

    // ✅ Main Query - LAST YEAR + CURRENT YEAR (FIX APPLIED)
    const result = await connection.request()
      .input("offset", offset)
      .input("pageSize", pageSize)
      .input("lastYear", lastYear)
      .query(`
        SELECT *
        FROM BarcodeView
        WHERE YEAR(DesignDate) >= @lastYear -- ✅ FIX: LAST YEAR + CURRENT YEAR (returns 100K+ records)
        ORDER BY Barcode
        OFFSET @offset ROWS
        FETCH NEXT @pageSize ROWS ONLY
      `);

    // ✅ Total count - LAST YEAR + CURRENT YEAR (FIX APPLIED)
    const countResult = await connection.request()
      .input("lastYear", lastYear)
      .query(`
        SELECT COUNT(*) as total
        FROM BarcodeView
        WHERE YEAR(DesignDate) >= @lastYear -- ✅ FIX: LAST YEAR + CURRENT YEAR
      `);

    const total = countResult.recordset[0].total;

    console.log("✅ Returned:", result.recordset.length, "/", total, "(LAST YEAR + CURRENT YEAR - 100K+ records)");

    res.json({
      success: true,
      data: result.recordset,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize)
      }
    });

  } catch (error) {
    console.log("❌ BARCODES ERROR:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
};

// ============================================
// 4. BRANCH LIST API - UNCHANGED
// ============================================
const getBranchList = async (req, res) => {
  try {
    const connection = await pool;
    
    console.log("📊 BRANCH LIST API - Fetching...");
    
    const result = await connection.request().query("SELECT * FROM BranchList");

    console.log("✅ BRANCH LIST returned:", result.recordset.length, "records");

    res.json({ success: true, data: result.recordset, count: result.recordset.length });

  } catch (error) {
    console.log("❌ BRANCH LIST ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ============================================
// 5. EMPLOYEE VIEW API - UNCHANGED
// ============================================
const getEmployeeView = async (req, res) => {
  try {
    const connection = await pool;
    
    console.log("📊 EMPLOYEE VIEW API - Fetching...");
    
    const result = await connection.request().query("SELECT * FROM Employee");

    console.log("✅ EMPLOYEE VIEW returned:", result.recordset.length, "records");

    res.json({ success: true, data: result.recordset, count: result.recordset.length });

  } catch (error) {
    console.log("❌ EMPLOYEE VIEW ERROR:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

module.exports = {
  getSalesReport,
  getSalesReportAll,
  getSalesReportCount,
  getBarcodes,
  getBranchList,
  getEmployeeView
};