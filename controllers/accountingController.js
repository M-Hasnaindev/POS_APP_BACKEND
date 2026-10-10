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
