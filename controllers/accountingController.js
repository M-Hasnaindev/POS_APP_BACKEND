const { getPoolForTenant } = require("../config/db");
const {
  executeAccountingSnapshot,
  resolveCompanyStartDate,
  pakistanToday,
  normalizePagination,
  resolveAuthenticatedCompanyCode,
} = require("../services/accountingService");
const { startJob, waitForJob, readPage } = require('../services/syncPageStore');
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
