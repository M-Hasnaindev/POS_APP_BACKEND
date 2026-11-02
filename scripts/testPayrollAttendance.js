const assert = require("node:assert/strict");
Object.assign(process.env, {
  DB_USER: "test",
  DB_PASSWORD: "test",
  DB_SERVER: "127.0.0.1",
  DB_PORT: "1433",
  DB_1_DATABASE: "test",
  DB_1_KEY: "test-key",
});
const {
  ATTENDANCE_HISTORY_SQL,
  loadAttendanceHistory,
  normalizeAttendanceHistoryInput,
} = require("../services/payrollAttendanceService");

async function main() {
  assert.deepEqual(
    normalizeAttendanceHistoryInput({ month: "10", year: "2026", employeeCode: "0000064" }),
    { month: 10, year: 2026, employeeCode: "0000064" },
  );
  assert.throws(() => normalizeAttendanceHistoryInput({ month: 13, year: 2026, employeeCode: "A" }));
  assert.throws(() => normalizeAttendanceHistoryInput({ month: 10, year: 2026, employeeCode: "" }));
  assert.equal(ATTENDANCE_HISTORY_SQL, "EXEC HREmployeeAttHistory @month, @year, @employeeCode, 'N'");

  const inputs = [];
  const request = {
    timeout: 0,
    cancel() {},
    input(name, type, value) { inputs.push({ name, type, value }); return this; },
    async query(query) {
      assert.equal(query, ATTENDANCE_HISTORY_SQL);
      return { recordset: [{ Date: "2026-10-01", Status: "Present" }] };
    },
  };
  const result = await loadAttendanceHistory({ request: () => request }, {
    month: 10,
    year: 2026,
    employeeCode: "0000064",
  });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(inputs.map(({ name, value }) => [name, value]), [
    ["month", "10"],
    ["year", "2026"],
    ["employeeCode", "0000064"],
  ]);
  console.log("PASS: payroll attendance procedure contract and validation");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
