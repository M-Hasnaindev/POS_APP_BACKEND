const { sql } = require("../config/db");
const { withSqlDeadline } = require("./sqlDeadline");

const ATTENDANCE_HISTORY_SQL =
  "EXEC HREmployeeAttHistory @month, @year, @employeeCode, 'N'";

function invalid(message) {
  return Object.assign(new Error(message), {
    statusCode: 422,
    code: "INVALID_ATTENDANCE_FILTER",
  });
}

function normalizeAttendanceHistoryInput(input = {}) {
  const month = Number.parseInt(String(input.month ?? ""), 10);
  const year = Number.parseInt(String(input.year ?? ""), 10);
  const employeeCode = String(input.employeeCode ?? "").trim();

  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw invalid("Month must be between 1 and 12.");
  }
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw invalid("Year is invalid.");
  }
  if (!employeeCode || employeeCode.length > 100 || /[\u0000-\u001f]/.test(employeeCode)) {
    throw invalid("Employee code is invalid.");
  }

  return { month, year, employeeCode };
}

async function loadAttendanceHistory(pool, input) {
  const filters = normalizeAttendanceHistoryInput(input);
  const request = pool.request();
  request.timeout = 60000;
  request
    .input("month", sql.VarChar(2), String(filters.month))
    .input("year", sql.VarChar(4), String(filters.year))
    .input("employeeCode", sql.VarChar(50), filters.employeeCode);

  const result = await withSqlDeadline(
    request,
    request.timeout,
    () => request.query(ATTENDANCE_HISTORY_SQL),
  );

  return {
    ...filters,
    rows: Array.isArray(result.recordset) ? result.recordset : [],
  };
}

module.exports = {
  ATTENDANCE_HISTORY_SQL,
  loadAttendanceHistory,
  normalizeAttendanceHistoryInput,
};
