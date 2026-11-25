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

const { resolveAuthenticatedCompanyCode } = require("../services/accountingService");
const {
  loadEmployeeMonthlySchedule,
  loadMonthlyAttendance,
  loadEmployeeSalary,
} = require("../services/payrollReportsService");

function payrollError(res, error, fallback, code) {
  const status = error.statusCode || 500;
  if (status >= 500) console.error(`[payroll] ${code}:`, error.message);
  const message = status < 500 ? error.message : fallback;
  return res.status(status).json({ success: false, code: error.code || code, message, msg: message });
}

async function signedInPool(req, res) {
  const tenantId = String(req.user?.tenantId || "").trim();
  if (!tenantId) {
    res.status(401).json({ success: false, message: "Please sign in again.", msg: "Please sign in again." });
    return null;
  }
  return getPoolForTenant(tenantId);
}

// GET /api/payroll/employeeMonthlySchedule/:empCode[?month=&year=]
// EXEC HREmployeeAttHistory <month>,<year>,<employeeCode>,'Y' (current PKT month by default)
exports.employeeMonthlySchedule = async (req, res) => {
  try {
    const pool = await signedInPool(req, res);
    if (!pool) return undefined;
    const result = await loadEmployeeMonthlySchedule(pool, {
      month: req.query?.month,
      year: req.query?.year,
      employeeCode: req.params?.empCode,
    });
    return res.json({
      success: true,
      employeeCode: result.employeeCode,
      month: result.month,
      year: result.year,
      scheduleMode: "Y",
      totalRecords: result.rows.length,
      data: result.rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return payrollError(res, error, "Employee schedule could not be loaded. Please retry.", "EMPLOYEE_SCHEDULE_FAILED");
  }
};

async function companyTable(req, res, load, fallback, code) {
  try {
    const pool = await signedInPool(req, res);
    if (!pool) return undefined;
    const companyCode = await resolveAuthenticatedCompanyCode(pool, String(req.user?.userId || "").trim(), req.user?.companyCode, req.headers["x-company-code"]);
    const result = await load(pool, companyCode, {
      month: req.query?.month,
      year: req.query?.year,
      employeeCode: req.query?.employeeCode ?? req.params?.empCode,
    });
    return res.json({
      success: true,
      companyCode: result.companyCode,
      month: result.month ?? null,
      year: result.year ?? null,
      employeeCode: result.employeeCode ?? null,
      totalRecords: result.rows.length,
      data: result.rows,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return payrollError(res, error, fallback, code);
  }
}

// GET /api/payroll/monthlyAttendance[?month=&year=&employeeCode=]
// SELECT * FROM PayrollAttendInfo (signed-in company only)
exports.monthlyAttendance = (req, res) =>
  companyTable(req, res, loadMonthlyAttendance, "Monthly attendance could not be loaded. Please retry.", "MONTHLY_ATTENDANCE_FAILED");

// GET /api/payroll/employeeSalary[?month=&year=&employeeCode=]
// SELECT * FROM PayRollSalaryFile (signed-in company only)
exports.employeeSalary = (req, res) =>
  companyTable(req, res, loadEmployeeSalary, "Employee salary could not be loaded. Please retry.", "EMPLOYEE_SALARY_FAILED");
