const zlib = require("zlib");
const { promisify } = require("util");
const {
  getStockSnapshot,
  startStockSnapshotJob,
  getStockSnapshotJob,
  getStockSnapshotJobPage,
  publicStockJob,
} = require("../services/stockSnapshotService");

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

exports.startSnapshotJob = (req, res) => {
  try {
    const job = startStockSnapshotJob(stockOptions(req));
    return res.status(job.status === "ready" ? 200 : 202).json({ success: true, ...job });
  } catch (error) {
    console.error("STOCK SNAPSHOT JOB START ERROR:", error?.message || error);
    return res.status(400).json({ success: false, message: error?.message || "Unable to start stock sync" });
  }
};

exports.getSnapshotJobStatus = (req, res) => {
  const job = getStockSnapshotJob(req.params.jobId, req.user.tenantId, req.user.userId);
  if (!job) return res.status(404).json({ success: false, message: "Stock sync job was not found" });
  return res.json({ success: true, ...publicStockJob(job) });
};

exports.getSnapshotJobPage = (req, res) => {
  const job = getStockSnapshotJob(req.params.jobId, req.user.tenantId, req.user.userId);
  if (!job) return res.status(404).json({ success: false, message: "Stock sync job was not found" });
  if (job.status === "failed") return res.status(503).json({ success: false, message: job.error });
  if (job.status !== "ready") return res.status(409).json({ success: false, message: "Stock sync is still processing" });
  return res.json({
    success: true,
    ...getStockSnapshotJobPage(job, req.query.page, req.query.pageSize),
    sourceCount: job.snapshot.procedureRows,
    generatedAt: job.generatedAt,
  });
};
