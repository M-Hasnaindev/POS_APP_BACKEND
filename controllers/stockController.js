const zlib = require("zlib");
const { promisify } = require("util");
const { getStockSnapshot } = require("../services/stockSnapshotService");

const gzip = promisify(zlib.gzip);

exports.getSnapshot = async (req, res) => {
  try {
    const { fromDate, toDate } = req.query;
    const snapshot = await getStockSnapshot({
      tenantId: req.user.tenantId,
      companyCode: req.user.companyCode,
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
