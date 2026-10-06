const { getPoolForTenant } = require("../config/db");
const {
  executeAccountingSnapshot,
  resolveCompanyStartDate,
  pakistanToday,
  normalizePagination,
  resolveAuthenticatedCompanyCode,
} = require("../services/accountingService");
const { startJob, waitForJob, readPage, findJob } = require('../services/syncPageStore');
const { promisify } = require('util');
const gzip = promisify(require('zlib').gzip);

exports.getAccountingRecords = async (req, res) => {
  try {
    const tenantId = String(req.user?.tenantId || "").trim();
    const userId = String(req.user?.userId || "").trim();

    if (!tenantId || !userId) {
      return res.status(401).json({
        success: false,
        message: "Authenticated tenant and user are required",
      });
    }

    const pool = await getPoolForTenant(tenantId);
    const companyCode = await resolveAuthenticatedCompanyCode(
      pool,
      userId,
      req.user?.companyCode,
      req.headers["x-company-code"],
    );
    const { page } = normalizePagination(req.query);
    const fromDate = await resolveCompanyStartDate(pool, companyCode);
    if (!fromDate) return res.status(422).json({ success: false, message: 'Company start date was not found in Defaults' });
    const toDate = pakistanToday();
    const options = { tenantId, userId, companyCode, fromDate, toDate };
    const started = await startJob('accounting', options, async onBatch => ({
      ...await executeAccountingSnapshot(pool, options, onBatch), fromDate, toDate,
    }), page > 1);
    const job = await waitForJob(started, tenantId, userId);
    const batch = await readPage(job, page);

    const payload = {
      success: true,
      ...batch,
      fromDate,
      toDate,
      companyCode,
      userId,
    };
    if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
      res.set('Content-Encoding', 'gzip'); res.set('Content-Type', 'application/json'); res.set('Vary', 'Accept-Encoding');
      return res.status(200).send(await gzip(Buffer.from(JSON.stringify(payload))));
    }
    return res.status(200).json(payload);
  } catch (error) {
    console.error("[Accounting] Sync failed", error?.message || error);
    const statusCode = error?.statusCode || 500;
    return res.status(statusCode).json({
      success: false,
      message:
        statusCode < 500
          ? error?.message || "Unable to load accounting data"
          : "Unable to load accounting data",
    });
  }
};

async function accountingJobContext(req) {
  const tenantId = String(req.user?.tenantId || "").trim();
  const userId = String(req.user?.userId || "").trim();
  if (!tenantId || !userId) {
    const error = new Error("Authenticated tenant and user are required");
    error.statusCode = 401;
    throw error;
  }
  const pool = await getPoolForTenant(tenantId);
  const companyCode = await resolveAuthenticatedCompanyCode(
    pool,
    userId,
    req.user?.companyCode,
    req.headers["x-company-code"],
  );
  const fromDate = await resolveCompanyStartDate(pool, companyCode);
  if (!fromDate) {
    const error = new Error("Company start date was not found in Defaults");
    error.statusCode = 422;
    throw error;
  }
  return { pool, tenantId, userId, companyCode, fromDate, toDate: pakistanToday() };
}

exports.startAccountingRecordsJob = async (req, res) => {
  try {
    const context = await accountingJobContext(req);
    const options = {
      tenantId: context.tenantId,
      userId: context.userId,
      companyCode: context.companyCode,
      fromDate: context.fromDate,
      toDate: context.toDate,
    };
    const job = await startJob('accounting', options, async onBatch => ({
      ...await executeAccountingSnapshot(context.pool, options, onBatch),
      fromDate: context.fromDate,
      toDate: context.toDate,
      companyCode: context.companyCode,
      userId: context.userId,
    }), false);
    return res.status(job.status === 'ready' ? 200 : 202).json({
      success: true,
      jobId: job.jobId,
      status: job.status,
      count: job.count,
      fromDate: context.fromDate,
      toDate: context.toDate,
      companyCode: context.companyCode,
      userId: context.userId,
    });
  } catch (error) {
    console.error('[Accounting] Job start failed', error?.message || error);
    const status = error?.statusCode || 503;
    return res.status(status).json({ success: false, message: status < 500 ? error.message : 'Accounting sync is temporarily unavailable. Please retry.' });
  }
};

exports.getAccountingRecordsJobStatus = async (req, res) => {
  try {
    const job = await findJob(req.params.jobId, req.user.tenantId, req.user.userId);
    if (!job) return res.status(404).json({ success: false, message: 'Accounting sync job was not found' });
    return res.json({ success: true, jobId: job.jobId, status: job.status, count: job.count, error: job.error, ...job.metadata });
  } catch (error) {
    console.error('[Accounting] Job status failed', error?.code || error?.name);
    return res.status(503).json({ success: false, message: 'Accounting status is temporarily unavailable. Please retry.' });
  }
};

exports.getAccountingRecordsJobPage = async (req, res) => {
  try {
    const job = await findJob(req.params.jobId, req.user.tenantId, req.user.userId);
    if (!job) return res.status(404).json({ success: false, message: 'Accounting sync job was not found' });
    if (job.status === 'failed') return res.status(503).json({ success: false, message: job.error || 'Accounting sync failed' });
    if (job.status !== 'ready') return res.status(409).json({ success: false, message: 'Accounting sync is still processing' });
    const batch = await readPage(job, req.query.page);
    const payload = { success: true, ...job.metadata, ...batch };
    if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
      res.set('Content-Encoding', 'gzip'); res.set('Content-Type', 'application/json'); res.set('Vary', 'Accept-Encoding');
      return res.send(await gzip(Buffer.from(JSON.stringify(payload))));
    }
    return res.json(payload);
  } catch (error) {
    console.error('[Accounting] Job page failed', error?.code || error?.name);
    return res.status(503).json({ success: false, message: 'Accounting page is temporarily unavailable. Please retry.' });
  }
};

const REPORT_TYPES = new Set([
  "accounting-ledger", "trial-balance", "income-statement", "balance-sheet",
  "audit-trial", "trial-balance-six-column", "account-movement",
  "month-wise-account", "month-wise-expense", "month-wise-cash-bank",
  "daily-cash-bank-flow", "party-wise-collection", "party-wise-payment",
  "chart-of-accounts", "post-dated-cheques", "receivable-aging",
  "payable-aging", "cash-bank-position",
]);

// Verified against the report modes supported by AccProc in the tenant ERP.
// Keeping this mapping server-side prevents arbitrary procedure modes from
// being supplied by a mobile client.
const ACC_PROC_REPORT_TYPES = Object.freeze({
  "accounting-ledger": "L",
  "trial-balance": "T",
  "income-statement": "I",
  "balance-sheet": "B",
  "audit-trial": "A",
  "trial-balance-six-column": "T",
  "account-movement": "LSUM",
  "month-wise-account": "MWR",
  "month-wise-expense": "BREXP",
  "month-wise-cash-bank": "BRANCHDCASH",
  "daily-cash-bank-flow": "DAILYCASH",
  "party-wise-collection": "PWC",
  "party-wise-payment": "PWP",
  "chart-of-accounts": "T",
  "post-dated-cheques": "PCHQLST",
  "receivable-aging": "AGING",
  "payable-aging": "AGINGWOOP",
  "cash-bank-position": "BRANCHDCASH",
});

// Finance reports intentionally execute AccProc live. They do not read the
// mobile ledger cache, so a user always receives the ERP's current figures.
exports.getLiveAccountingReport = async (req, res) => {
  try {
    const tenantId = String(req.user?.tenantId || "").trim();
    const userId = String(req.user?.userId || "").trim();
    const reportType = String(req.params.reportType || "").trim().toLowerCase();
    if (!tenantId || !userId) return res.status(401).json({ success: false, message: "Authenticated tenant and user are required" });
    if (!REPORT_TYPES.has(reportType)) return res.status(400).json({ success: false, message: "Unsupported accounting report" });

    const pool = await getPoolForTenant(tenantId);
    const companyCode = await resolveAuthenticatedCompanyCode(pool, userId, req.user?.companyCode, req.headers["x-company-code"]);
    const companyFromDate = await resolveCompanyStartDate(pool, companyCode);
    const today = pakistanToday();
    const requestedFrom = String(req.query.fromDate || "").slice(0, 10);
    const requestedTo = String(req.query.toDate || "").slice(0, 10);
    const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedFrom) && requestedFrom >= companyFromDate ? requestedFrom : companyFromDate;
    const toDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedTo) && requestedTo <= today ? requestedTo : today;
    if (fromDate > toDate) return res.status(422).json({ success: false, message: "From date cannot be after to date" });

    const procedureReportType = ACC_PROC_REPORT_TYPES[reportType];
    const rows = await executeAccountingSnapshot(pool, { fromDate, toDate, userId, companyCode, reportType: procedureReportType });
    return res.json({ success: true, reportType, procedureReportType, fromDate, toDate, companyCode, count: rows.length, data: rows });
  } catch (error) {
    console.error("[Accounting] Live report failed", error?.message || error);
    return res.status(error?.statusCode || 500).json({ success: false, message: error?.statusCode ? error.message : "Unable to generate accounting report" });
  }
};
