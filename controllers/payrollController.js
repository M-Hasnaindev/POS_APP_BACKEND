const { getPoolForTenant } = require("../config/db");
const { loadAttendanceHistory } = require("../services/payrollAttendanceService");

exports.getAttendanceHistory = async (req, res) => {
  try {
    const tenantId = String(req.user?.tenantId || "").trim();
    if (!tenantId) {
      return res.status(401).json({ success: false, message: "Please sign in again." });
    }

    const pool = await getPoolForTenant(tenantId);
    const result = await loadAttendanceHistory(pool, {
      month: req.body?.month ?? req.query?.month,
      year: req.body?.year ?? req.query?.year,
      employeeCode: req.body?.employeeCode ?? req.params?.empCode,
    });
    return res.json({
      success: true,
      data: result.rows,
      count: result.rows.length,
      totalRecords: result.rows.length,
      month: result.month,
      year: result.year,
      employeeCode: result.employeeCode,
      scheduleMode: "N",
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const status = error.statusCode || 500;
    return res.status(status).json({
      success: false,
      code: error.code || "ATTENDANCE_HISTORY_FAILED",
      message: status < 500
        ? error.message
        : "Attendance history could not be loaded. Please retry.",
      msg: status < 500
        ? error.message
        : "Attendance history could not be loaded. Please retry.",
    });
  }
};
