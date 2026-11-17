// ============================================
// DAILY CLOSING API (read-only)
// GET /api/sales/closings?from=YYYY-MM-DD&to=YYYY-MM-DD&branch=
// GET /api/sales/closings/:tranNo/breakup?branch=
// The company always comes from the signed-in token, never from the request.
// ============================================

const { sql, getPoolForTenant, sendDatabaseError } = require("../config/db");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

function companyOf(req) {
  return String(req.user?.companyCode || "").trim();
}

function pakistanToday() {
  return new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayDiff(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

// Dates and times are returned as plain text so the app shows the shop's wall-clock time unchanged.
const CLOSING_COLUMNS = `
  M.TranNo, LTRIM(RTRIM(M.Branch)) AS Branch, ISNULL(MAX(B.BranchName), '') AS BranchName,
  LTRIM(RTRIM(ISNULL(M.CounterNo, ''))) AS CounterNo,
  CONVERT(char(10), M.DateFr, 23) AS DateFr, CONVERT(char(10), M.DateTo, 23) AS DateTo,
  CONVERT(char(19), M.EntryDate, 120) AS EntryDate, LTRIM(RTRIM(ISNULL(M.EntryBy, ''))) AS EntryBy,
  LTRIM(RTRIM(ISNULL(M.EntryIP, ''))) AS EntryIP, LTRIM(RTRIM(ISNULL(M.Remarks, ''))) AS Remarks,
  M.FiveThousand, M.Thousand, M.FiveHundred, M.Hundred, M.Fifty, M.Twenty, M.Ten, M.Five, M.Two, M.One, M.Total,
  M.OpeningBal, M.TotCashSales, M.CashReturn, M.Payments, M.Receipts, M.Difference, M.NetCash,
  M.CashSales, M.CardSales, M.CreditSales, M.SalesReturn, M.CreditReturn, M.CardReturn, M.NetSales, M.TotalQty,
  M.NoBill, M.NoCancel, M.NoHold, M.NoUnpaid, M.Paid`;

const CLOSING_GROUP = `
  M.TranNo, M.Branch, M.CounterNo, M.DateFr, M.DateTo, M.EntryDate, M.EntryBy, M.EntryIP, M.Remarks,
  M.FiveThousand, M.Thousand, M.FiveHundred, M.Hundred, M.Fifty, M.Twenty, M.Ten, M.Five, M.Two, M.One, M.Total,
  M.OpeningBal, M.TotCashSales, M.CashReturn, M.Payments, M.Receipts, M.Difference, M.NetCash,
  M.CashSales, M.CardSales, M.CreditSales, M.SalesReturn, M.CreditReturn, M.CardReturn, M.NetSales, M.TotalQty,
  M.NoBill, M.NoCancel, M.NoHold, M.NoUnpaid, M.Paid`;

const getClosings = async (req, res) => {
  const companyCode = companyOf(req);
  if (!companyCode) return res.status(400).json({ success: false, message: "Company is missing from the session." });

  const today = pakistanToday();
  const to = DATE_RE.test(String(req.query.to || "")) ? String(req.query.to) : today;
  const from = DATE_RE.test(String(req.query.from || "")) ? String(req.query.from) : to;
  if (dayDiff(from, to) < 0) return res.status(400).json({ success: false, message: "From date is after To date." });
  if (dayDiff(from, to) > MAX_RANGE_DAYS) return res.status(400).json({ success: false, message: `Please choose ${MAX_RANGE_DAYS} days or fewer.` });
  const branch = String(req.query.branch || "").trim();

  try {
    const pool = await getPoolForTenant(req.user.tenantId);
    const request = pool.request()
      .input("companyCode", sql.VarChar(50), companyCode)
      .input("from", sql.Date, from)
      .input("to", sql.Date, to);
    if (branch) request.input("branch", sql.VarChar(50), branch);

    // BranchList can hold more than one row per code, hence the GROUP BY with MAX(BranchName).
    const result = await request.query(`
      SELECT ${CLOSING_COLUMNS}
      FROM PosClosing M
      LEFT JOIN BranchList B ON LTRIM(RTRIM(B.BranchCode)) = LTRIM(RTRIM(M.Branch))
      WHERE LTRIM(RTRIM(M.CompanyCode)) = @companyCode
        AND M.DateTo >= @from AND M.DateFr <= @to
        ${branch ? "AND LTRIM(RTRIM(M.Branch)) = @branch" : ""}
      GROUP BY ${CLOSING_GROUP}
      ORDER BY M.DateTo DESC, M.EntryDate DESC`);

    res.json({ success: true, from, to, data: result.recordset, count: result.recordset.length });
  } catch (error) {
    console.log("❌ CLOSINGS ERROR:", error.message);
    sendDatabaseError(res, error, "Daily closings could not be loaded.");
  }
};

// Payment vouchers (/P/) from the cash book and the bank book for one closing.
// Based on the desktop GetClosingVoucherBreakup, with UNION ALL so equal rows from the
// two books are both counted. A closing saved again for the same day keeps the cumulative
// window: in the data those re-saves repeat the earlier closing's figures.
const BOOK_QUERY = (table, label) => `
  SELECT '${label}' AS Book, V.ActCod, MAX(C.AcName) AS AccountName,
         LTRIM(RTRIM(ISNULL(V.Description1, ''))) AS Narration, SUM(V.Debit) AS Amount
  FROM ${table} V
  CROSS JOIN ClosingPeriod P
  LEFT JOIN Chart C ON C.ActCod = V.ActCod
  WHERE V.CompanyCode = P.CompanyCode AND V.Branch = P.Branch
    AND V.Voucher LIKE '%/P/%'
    AND V.BookAccount = 'N'
    AND V.VoucherDate >= P.DateFr AND V.VoucherDate <= P.DateTo
    AND V.EntryDate <= P.EntryCutoff
    AND ISNULL(V.CancelVoucher, '') <> 'Y'
  GROUP BY V.ActCod, LTRIM(RTRIM(ISNULL(V.Description1, '')))
  HAVING SUM(V.Debit) > 0`;

const getClosingBreakup = async (req, res) => {
  const companyCode = companyOf(req);
  const tranNo = String(req.params.tranNo || "").trim();
  const branch = String(req.query.branch || "").trim();
  if (!companyCode) return res.status(400).json({ success: false, message: "Company is missing from the session." });
  if (!tranNo || !branch) return res.status(400).json({ success: false, message: "Closing number and branch are required." });

  try {
    const pool = await getPoolForTenant(req.user.tenantId);
    const result = await pool.request()
      .input("companyCode", sql.VarChar(50), companyCode)
      .input("tranNo", sql.VarChar(50), tranNo)
      .input("branch", sql.VarChar(50), branch)
      .query(`
        ;WITH ThisClosing AS (
          SELECT TOP 1 M.CompanyCode, M.Branch, CONVERT(date, M.DateFr) AS DateFr, CONVERT(date, M.DateTo) AS DateTo,
                 CONVERT(datetime, CONVERT(char(19), M.EntryDate, 120), 120) AS EntryCutoff
          FROM PosClosing M
          WHERE M.TranNo = @tranNo AND LTRIM(RTRIM(M.Branch)) = @branch AND LTRIM(RTRIM(M.CompanyCode)) = @companyCode
          ORDER BY M.EntryDate DESC
        ),
        ClosingPeriod AS (SELECT * FROM ThisClosing),
        Breakup AS (
          ${BOOK_QUERY("CBook", "Cash")}
          UNION ALL
          ${BOOK_QUERY("BBook", "Bank")}
        )
        SELECT CASE WHEN ActCod LIKE '5%' THEN 1 ELSE 0 END AS IsExpense,
               Book, LTRIM(RTRIM(ActCod)) AS ActCod, LTRIM(RTRIM(ISNULL(AccountName, ''))) AS AccountName, Narration, Amount
        FROM Breakup
        WHERE ActCod IS NOT NULL
        ORDER BY IsExpense, ActCod, Narration, Amount;

        SELECT COUNT(*) AS found FROM PosClosing
        WHERE TranNo = @tranNo AND LTRIM(RTRIM(Branch)) = @branch AND LTRIM(RTRIM(CompanyCode)) = @companyCode;`);

    if (!result.recordsets[1]?.[0]?.found) return res.status(404).json({ success: false, message: "Closing was not found." });
    const rows = result.recordsets[0].map((row) => ({
      section: row.IsExpense ? "expense" : "payment",
      book: row.Book,
      accountCode: row.ActCod,
      accountName: row.AccountName,
      narration: row.Narration,
      amount: Number(row.Amount || 0),
    }));
    const sum = (section) => rows.filter((row) => row.section === section).reduce((total, row) => total + row.amount, 0);
    res.json({ success: true, tranNo, branch, rows, totals: { payments: sum("payment"), expenses: sum("expense") } });
  } catch (error) {
    console.log("❌ CLOSING BREAKUP ERROR:", error.message);
    sendDatabaseError(res, error, "Closing breakup could not be loaded.");
  }
};

module.exports = { getClosings, getClosingBreakup };
