const assert = require("node:assert/strict");
Object.assign(process.env, {
  DB_USER: "test",
  DB_PASSWORD: "test",
  DB_SERVER: "127.0.0.1",
  DB_PORT: "1433",
  DB_1_DATABASE: "test",
  DB_1_KEY: "test-key",
});
const service = require("../services/payrollReportsService");

function fakePool(recordset = [{ ok: 1 }]) {
  const calls = [];
  return {
    calls,
    request() {
      const call = { inputs: {}, query: "" };
      calls.push(call);
      return {
        timeout: 0,
        cancel() {},
        input(name, _type, value) { call.inputs[name] = value; return this; },
        async query(query) { call.query = query; return { recordset }; },
      };
    },
  };
}

async function main() {
  // Current month in Pakistan time (UTC+5): 31 Oct 21:00 UTC is already 1 Nov in PKT.
  assert.deepEqual(service.currentPakistanMonth(new Date("2026-10-31T21:00:00Z")), { month: 11, year: 2026 });

  // 1. Employee monthly schedule: EXEC HREmployeeAttHistory ...,'Y', current month by default.
  let pool = fakePool([{ Day: 1 }]);
  let result = await service.loadEmployeeMonthlySchedule(pool, { employeeCode: " 0000064 " }, new Date("2026-11-25T10:00:00Z"));
  assert.equal(pool.calls[0].query, "EXEC HREmployeeAttHistory @month, @year, @employeeCode, 'Y'");
  assert.deepEqual(pool.calls[0].inputs, { month: "11", year: "2026", employeeCode: "0000064" });
  assert.equal(result.rows.length, 1);
  pool = fakePool();
  await service.loadEmployeeMonthlySchedule(pool, { employeeCode: "A1", month: "3", year: "2026" });
  assert.deepEqual(pool.calls[0].inputs, { month: "3", year: "2026", employeeCode: "A1" });
  await assert.rejects(() => service.loadEmployeeMonthlySchedule(fakePool(), { employeeCode: "" }), /Employee code/);

  // 2. Monthly attendance: SELECT * FROM PayrollAttendInfo, only the signed-in company.
  pool = fakePool([{ EmpId: "1" }, { EmpId: "2" }]);
  result = await service.loadMonthlyAttendance(pool, " UR ", {});
  assert.match(pool.calls[0].query, /^SELECT \* FROM PayrollAttendInfo WHERE LTRIM\(RTRIM\(CompanyCode\)\) = @companyCode ORDER BY /);
  assert.deepEqual(pool.calls[0].inputs, { companyCode: "UR" });
  assert.equal(result.rows.length, 2);
  pool = fakePool();
  await service.loadMonthlyAttendance(pool, "UR", { month: "11", year: "2026", employeeCode: "0000064" });
  assert.match(pool.calls[0].query, /AttSalaryMonth = @month AND AttSalaryYear = @year AND LTRIM\(RTRIM\(EmpId\)\) = @employeeCode/);
  assert.deepEqual(pool.calls[0].inputs, { companyCode: "UR", month: 11, year: 2026, employeeCode: "0000064" });

  // 3. Employee salary: SELECT * FROM PayRollSalaryFile, only the signed-in company.
  pool = fakePool();
  await service.loadEmployeeSalary(pool, "UR", { month: 10, year: 2026 });
  assert.match(pool.calls[0].query, /^SELECT \* FROM PayRollSalaryFile WHERE LTRIM\(RTRIM\(CompanyCode\)\) = @companyCode AND SalaryMonth = @month AND SalaryYear = @year ORDER BY /);

  // Values never reach the SQL text; bad filters and a missing company are refused.
  pool = fakePool();
  await service.loadEmployeeSalary(pool, "UR", { employeeCode: "x' OR 1=1 --" });
  assert.ok(!pool.calls[0].query.includes("OR 1=1"));
  await assert.rejects(() => service.loadEmployeeSalary(fakePool(), "UR", { month: 11 }), /both month and year/);
  await assert.rejects(() => service.loadEmployeeSalary(fakePool(), "UR", { month: 13, year: 2026 }), /Month must be/);
  await assert.rejects(() => service.loadMonthlyAttendance(fakePool(), "", {}), (error) => error.statusCode === 403);

  console.log("PASS: payroll schedule (current PKT month), monthly attendance and salary APIs are company-scoped, parameterised and validated.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
