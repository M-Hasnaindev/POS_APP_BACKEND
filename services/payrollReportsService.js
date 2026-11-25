const { sql } = require("../config/db");
const { withSqlDeadline } = require("./sqlDeadline");
const { normalizeAttendanceHistoryInput } = require("./payrollAttendanceService");

// Payroll read APIs. Every query is read-only and parameterised; table queries
// return only the signed-in company's rows (a database can hold several companies).
const REQUEST_TIMEOUT_MS = 60000;

const EMPLOYEE_MONTHLY_SCHEDULE_SQL =
  "EXEC HREmployeeAttHistory @month, @year, @employeeCode, 'Y'";
const MONTHLY_ATTENDANCE_SQL = "SELECT * FROM PayrollAttendInfo";
const EMPLOYEE_SALARY_SQL = "SELECT * FROM PayRollSalaryFile";

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 422, code: "INVALID_PAYROLL_FILTER" });
}

/** Current month and year in Pakistan time (PKT, UTC+5). */
function currentPakistanMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit" })
    .formatToParts(now);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { month: value("month"), year: value("year") };
}

/** Optional month / year / employee filters; month and year must come together. */
function normalizePeriodFilters(input = {}) {
  const has = (value) => value !== undefined && value !== null && String(value).trim() !== "";
  const filters = {};
  if (has(input.month) || has(input.year)) {
    if (!has(input.month) || !has(input.year)) throw invalid("Send both month and year, or neither.");
    const month = Number.parseInt(String(input.month), 10);
    const year = Number.parseInt(String(input.year), 10);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw invalid("Month must be between 1 and 12.");
    if (!Number.isInteger(year) || year < 2000 || year > 2100) throw invalid("Year is invalid.");
    Object.assign(filters, { month, year });
  }
  if (has(input.employeeCode)) {
    const employeeCode = String(input.employeeCode).trim();
    if (employeeCode.length > 100 || /[\u0000-\u001f]/.test(employeeCode)) throw invalid("Employee code is invalid.");
    filters.employeeCode = employeeCode;
  }
  return filters;
}

async function run(request, query) {
  request.timeout = REQUEST_TIMEOUT_MS;
  const result = await withSqlDeadline(request, REQUEST_TIMEOUT_MS, () => request.query(query));
  return Array.isArray(result.recordset) ? result.recordset : [];
}

/** EXEC HREmployeeAttHistory <month>,<year>,<employee>,'Y' — defaults to the current PKT month. */
async function loadEmployeeMonthlySchedule(pool, input = {}, now = new Date()) {
  const period = input.month || input.year ? {} : currentPakistanMonth(now);
  const filters = normalizeAttendanceHistoryInput({ month: input.month ?? period.month, year: input.year ?? period.year, employeeCode: input.employeeCode });
  const request = pool.request()
    .input("month", sql.VarChar(2), String(filters.month))
    .input("year", sql.VarChar(4), String(filters.year))
    .input("employeeCode", sql.VarChar(50), filters.employeeCode);
  return { ...filters, rows: await run(request, EMPLOYEE_MONTHLY_SCHEDULE_SQL) };
}

/** SELECT * FROM <table> for the signed-in company, with optional month/year/employee filters. */
function scopedQuery(base, columns, companyCode, filters) {
  const where = ["LTRIM(RTRIM(CompanyCode)) = @companyCode"];
  if (filters.month) where.push(`${columns.month} = @month`, `${columns.year} = @year`);
  if (filters.employeeCode) where.push("LTRIM(RTRIM(EmpId)) = @employeeCode");
  const order = columns.order ? ` ORDER BY ${columns.order}` : "";
  return { query: `${base} WHERE ${where.join(" AND ")}${order}`, companyCode: String(companyCode || "").trim() };
}

async function loadScopedTable(pool, base, columns, companyCode, input) {
  const filters = normalizePeriodFilters(input);
  const { query, companyCode: company } = scopedQuery(base, columns, companyCode, filters);
  if (!company) throw Object.assign(new Error("Your company could not be identified. Please sign in again."), { statusCode: 403, code: "COMPANY_REQUIRED" });
  const request = pool.request().input("companyCode", sql.VarChar(50), company);
  if (filters.month) request.input("month", sql.Int, filters.month).input("year", sql.Int, filters.year);
  if (filters.employeeCode) request.input("employeeCode", sql.NVarChar(100), filters.employeeCode);
  return { ...filters, companyCode: company, rows: await run(request, query) };
}

const ATTENDANCE_COLUMNS = { month: "AttSalaryMonth", year: "AttSalaryYear", order: "AttSalaryYear DESC, AttSalaryMonth DESC, EmpId, AttDateIn" };
const SALARY_COLUMNS = { month: "SalaryMonth", year: "SalaryYear", order: "SalaryYear DESC, SalaryMonth DESC, EmpId" };

/** SELECT * FROM PayrollAttendInfo (signed-in company). */
const loadMonthlyAttendance = (pool, companyCode, input) =>
  loadScopedTable(pool, MONTHLY_ATTENDANCE_SQL, ATTENDANCE_COLUMNS, companyCode, input);

/** SELECT * FROM PayRollSalaryFile (signed-in company). */
const loadEmployeeSalary = (pool, companyCode, input) =>
  loadScopedTable(pool, EMPLOYEE_SALARY_SQL, SALARY_COLUMNS, companyCode, input);

module.exports = {
  EMPLOYEE_MONTHLY_SCHEDULE_SQL,
  MONTHLY_ATTENDANCE_SQL,
  EMPLOYEE_SALARY_SQL,
  currentPakistanMonth,
  normalizePeriodFilters,
  scopedQuery,
  loadEmployeeMonthlySchedule,
  loadMonthlyAttendance,
  loadEmployeeSalary,
};
