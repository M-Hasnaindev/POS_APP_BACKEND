const { sql } = require('../config/db');
const aiConfig = require('../config/ai');

function normalizeList(value) {
  if (Array.isArray(value)) return value.filter((item) => item != null && String(item).trim() !== '').map(String);
  if (value == null || String(value).trim() === '') return [];
  return [String(value)];
}

function addListFilter(request, clauses, expression, prefix, values) {
  const safe = normalizeList(values);
  if (!safe.length) return;
  const params = safe.map((value, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.NVarChar(50), value);
    return `@${name}`;
  });
  clauses.push(`${expression} IN (${params.join(',')})`);
}

/**
 * Supplier payment reporting is accounting-ledger data, NOT POS tender mix.
 * This mirrors Cherry accounting conventions used by AccProc:
 * - /P/ voucher = payment
 * - BookAccount='N' = party/detail line
 * - Chart.PartyType='S' = supplier
 * - supplier display name comes from Chart.AcName
 * - cancelled vouchers are excluded
 * - both CBook (cash) and BBook (bank) are included
 * - GLContraActCod is used for inter-branch/contra party lines when present
 */
async function runSupplierPayments(pool, user, filters = {}, options = {}) {
  const request = pool.request();
  request.timeout = aiConfig.sqlTimeoutMs;
  request.input('companyCode', sql.VarChar(20), String(user?.companyCode || ''));
  request.input('fromDate', sql.Date, filters.fromDate);
  request.input('toDate', sql.Date, filters.toDate);

  const cashClauses = [];
  const bankClauses = [];
  addListFilter(request, cashClauses, 'cb.Branch', 'cashBranch', filters.branches);
  addListFilter(request, bankClauses, 'bb.Branch', 'bankBranch', filters.branches);
  const cashBranch = cashClauses.length ? ` AND ${cashClauses.join(' AND ')}` : '';
  const bankBranch = bankClauses.length ? ` AND ${bankClauses.join(' AND ')}` : '';

  const result = await request.query(`
    WITH ChartSupplier AS (
      SELECT ActCod, MAX(AcName) AcName
      FROM Chart
      WHERE ISNULL(PartyType,'')='S'
      GROUP BY ActCod
    ), SupplierLedger AS (
      SELECT
        CASE WHEN ISNULL(cb.BranchTo,'')<>'' AND ISNULL(cb.GLContraActCod,'')<>'' THEN cb.GLContraActCod ELSE cb.ActCod END SupplierCode,
        SUM(CASE WHEN ISNULL(cb.Debit,0)>0 THEN ISNULL(cb.Debit,0) ELSE 0 END) Amount
      FROM CBook cb
      WHERE cb.CompanyCode=@companyCode
        AND cb.VoucherDate>=@fromDate AND cb.VoucherDate<DATEADD(day,1,@toDate)
        AND cb.BookAccount='N'
        AND CHARINDEX('/P/',ISNULL(cb.Voucher,''))>0
        AND ISNULL(cb.CancelVoucher,'')<>'Y'
        ${cashBranch}
      GROUP BY CASE WHEN ISNULL(cb.BranchTo,'')<>'' AND ISNULL(cb.GLContraActCod,'')<>'' THEN cb.GLContraActCod ELSE cb.ActCod END

      UNION ALL

      SELECT
        CASE WHEN ISNULL(bb.BranchTo,'')<>'' AND ISNULL(bb.GLContraActCod,'')<>'' THEN bb.GLContraActCod ELSE bb.ActCod END SupplierCode,
        SUM(CASE WHEN ISNULL(bb.Debit,0)>0 THEN ISNULL(bb.Debit,0) ELSE 0 END) Amount
      FROM BBook bb
      WHERE bb.CompanyCode=@companyCode
        AND bb.VoucherDate>=@fromDate AND bb.VoucherDate<DATEADD(day,1,@toDate)
        AND bb.BookAccount='N'
        AND CHARINDEX('/P/',ISNULL(bb.Voucher,''))>0
        AND ISNULL(bb.CancelVoucher,'')<>'Y'
        ${bankBranch}
      GROUP BY CASE WHEN ISNULL(bb.BranchTo,'')<>'' AND ISNULL(bb.GLContraActCod,'')<>'' THEN bb.GLContraActCod ELSE bb.ActCod END
    ), Ranked AS (
      SELECT sl.SupplierCode, cs.AcName SupplierName, SUM(ISNULL(sl.Amount,0)) Amount
      FROM SupplierLedger sl
      INNER JOIN ChartSupplier cs ON cs.ActCod=sl.SupplierCode
      GROUP BY sl.SupplierCode, cs.AcName
      HAVING SUM(ISNULL(sl.Amount,0))>0
    )
    SELECT SupplierCode, SupplierName Label, Amount,
      SUM(Amount) OVER() OverallAmount
    FROM Ranked
    ORDER BY Amount DESC, SupplierName ASC;
  `);

  let rows = result.recordset || [];
  const accountFilters = normalizeList(filters.accounts);
  if (accountFilters.length) rows = rows.filter((row) => accountFilters.includes(String(row.SupplierCode || '')));
  const total = rows.reduce((sum, row) => sum + Number(row.Amount || 0), 0);
  const top = rows[0] || null;
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 100));
  rows = rows.slice(0, limit);

  return {
    title: 'Supplier Payments',
    kpis: [
      { key: 'TotalPaid', label: 'Total Supplier Payment', format: 'currency', value: total },
      { key: 'SupplierCount', label: 'Suppliers Paid', format: 'number', value: rows.length },
      { key: 'TopSupplierAmount', label: 'Top Supplier Payment', format: 'currency', value: Number(top?.Amount || 0) },
    ],
    charts: [{ type: 'bar', title: 'Supplier Payments', data: rows.slice(0, 20) }],
    rows,
    note: 'Supplier payment is calculated from live CBook + BBook payment vouchers (/P/), supplier party accounts only, excluding cancelled vouchers.',
  };
}

module.exports = { runSupplierPayments };
