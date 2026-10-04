const { getPoolForTenant } = require("../config/db");
const {
  loadAccountingSnapshot,
  normalizePagination,
  resolveAuthenticatedCompanyCode,
} = require("../services/accountingService");

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
    const { page, pageSize } = normalizePagination(req.query);
    const { rows, fromDate, toDate } = await loadAccountingSnapshot({
      pool,
      tenantId,
      userId,
      companyCode,
    });
    const offset = (page - 1) * pageSize;
    const data = rows.slice(offset, offset + pageSize);

    return res.status(200).json({
      success: true,
      data,
      count: data.length,
      total: rows.length,
      page,
      pageSize,
      hasMore: offset + data.length < rows.length,
      fromDate,
      toDate,
      companyCode,
      userId,
    });
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
