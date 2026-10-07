const zlib = require("zlib");
const { promisify } = require("util");
const {
  getStockSnapshot,
} = require("../services/stockSnapshotService");
const { findJob, readPage } = require("../services/syncPageStore");
const { startStockJob, getStockJob } = require("../services/stockSyncJobs");
const { isTransientDatabaseError } = require("../config/db");

const gzip = promisify(zlib.gzip);

exports.getSnapshot = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const snapshot = await getStockSnapshot({
      tenantId: req.user.tenantId,
      companyCode: req.user.companyCode,
      requestedCompanyCode: req.headers["x-company-code"],
      userId: req.user.userId,
      fromDate,
      toDate,
    });
    const payload = {
      success: true,
      data: snapshot.rows,
      count: snapshot.rows.length,
      sourceCount: snapshot.procedureRows,
      dateRange: { from: fromDate, to: toDate },
      generatedAt: new Date().toISOString(),
      durationMs: snapshot.durationMs,
    };

    if (/\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""))) {
      const compressed = await gzip(Buffer.from(JSON.stringify(payload)), { level: 6 });
      res.set("Content-Type", "application/json; charset=utf-8");
      res.set("Content-Encoding", "gzip");
      res.set("Vary", "Accept-Encoding");
      return res.status(200).send(compressed);
    }
    return res.json(payload);
  } catch (error) {
    console.error("STOCK SNAPSHOT ERROR:", error.message);
    const status = ["INVALID_DATE_RANGE", "COMPANY_CODE_REQUIRED"].includes(error.code) ? 400 : 500;
    return res.status(status).json({
      success: false,
      message: status === 400 ? error.message : "Unable to prepare stock snapshot",
    });
  }
};

function stockOptions(req) {
  return {
    tenantId: req.user.tenantId,
    companyCode: req.user.companyCode,
    requestedCompanyCode: req.headers["x-company-code"],
    userId: req.user.userId,
    fromDate: req.query.fromDate,
    toDate: req.query.toDate,
  };
}

exports.startSnapshotJob = async (req, res) => {
  try {
    const options = stockOptions(req);
    const job = await startStockJob(options);
    return res.status(job.status === "ready" ? 200 : 202).json({ success: true, ...job });
  } catch (error) {
    console.error("STOCK SNAPSHOT JOB START ERROR:", error?.message || error);
    const invalid = ['INVALID_DATE_RANGE', 'COMPANY_CODE_REQUIRED'].includes(error?.code);
    return res.status(invalid ? 400 : 503).json({ success: false, message: invalid ? error.message : "Stock sync is temporarily unavailable. Please retry." });
  }
};

exports.getSnapshotJobStatus = async (req, res) => {
  try {
  const job = await getStockJob(req.params.jobId, req.user.tenantId, req.user.userId);
  if (!job) return res.status(404).json({ success: false, message: "Stock sync job was not found" });
  return res.json({ success: true, ...job });
  } catch (error) {
    const log = isTransientDatabaseError(error) ? console.warn : console.error;
    log('[StockSync] Status temporarily unavailable:', error.code || error.name);
    res.set('Retry-After', '3');
    return res.status(503).json({ success: false, code: 'STOCK_STATUS_TEMPORARILY_UNAVAILABLE', retryable: true, message: 'Stock status is temporarily unavailable. Please retry.' });
  }
};

exports.getSnapshotJobPage = async (req, res) => {
  try {
  const job = await findJob(req.params.jobId, req.user.tenantId, req.user.userId);
  if (!job) return res.status(404).json({ success: false, message: "Stock sync job was not found" });
  if (job.status === "failed") return res.status(503).json({ success: false, message: job.error });
  if (job.status !== "ready") return res.status(409).json({ success: false, message: "Stock sync is still processing" });
  const payload = {
    success: true,
    ...await readPage(job, req.query.page),
    sourceCount: job.sourceCount,
    generatedAt: job.generatedAt,
  };
  if (/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) {
    res.set('Content-Encoding', 'gzip'); res.set('Content-Type', 'application/json'); res.set('Vary', 'Accept-Encoding');
    return res.send(await gzip(Buffer.from(JSON.stringify(payload))));
  }
  return res.json(payload);
  } catch (error) {
    console.error('[StockSync] Page unavailable:', error.code || error.name);
    return res.status(503).json({ success: false, message: 'Stock page is temporarily unavailable. Please retry.' });
  }
};
