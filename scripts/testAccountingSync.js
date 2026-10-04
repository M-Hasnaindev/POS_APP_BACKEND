const assert = require("assert");
const {
  ACC_PROC_SQL,
  clearAccountingSnapshotCache,
  loadAccountingSnapshot,
  normalizeDateOnly,
  normalizePagination,
  pakistanToday,
  resolveAuthenticatedCompanyCode,
} = require("../services/accountingService");

assert.strictEqual(normalizeDateOnly("2026-06-01T00:00:00.000Z"), "2026-06-01");
assert.strictEqual(normalizeDateOnly("1/6/2026"), "2026-06-01");
assert.strictEqual(normalizeDateOnly(new Date("2026-06-01T00:00:00Z")), "2026-06-01");
assert.deepStrictEqual(normalizePagination({ page: "2", pageSize: "9000" }), {
  page: 2,
  pageSize: 5000,
});
assert.strictEqual(pakistanToday(new Date("2026-10-01T20:00:00Z")), "2026-10-02");

for (const required of [
  "EXEC AccProc",
  "@fromDate",
  "@toDate",
  "'L'",
  "'AL'",
  "@userId",
  "'ALL'",
  "'00000000000000'",
  "'zzzzzzzzzzzzzz'",
  "@companyCode",
  "'B'",
  "'V'",
]) {
  assert.ok(ACC_PROC_SQL.includes(required), `Missing AccProc argument: ${required}`);
}

(async () => {
  clearAccountingSnapshotCache();
  const tokenCompany = await resolveAuthenticatedCompanyCode({}, "Cherrys", "UR");
  assert.strictEqual(tokenCompany, "UR");

  const legacyTokenPool = {
    request() {
      const request = {
        input() {
          return request;
        },
        async query() {
          return { recordset: [{ CompanyCode: " UR " }] };
        },
      };
      return request;
    },
  };
  const resolvedLegacyCompany = await resolveAuthenticatedCompanyCode(
    legacyTokenPool,
    "Cherrys",
    "",
  );
  assert.strictEqual(resolvedLegacyCompany, "UR");

  const adminWithoutCompanyPool = {
    request() {
      const request = {
        input() {
          return request;
        },
        async query(query) {
          if (query.includes("FROM Security")) return { recordset: [] };
          if (query.includes("FROM BranchFile")) return { recordset: [{ CompanyCode: " UR " }] };
          return { recordset: [] };
        },
      };
      return request;
    },
  };
  const resolvedAdminCompany = await resolveAuthenticatedCompanyCode(
    adminWithoutCompanyPool,
    "Cherrys",
    "",
    "",
  );
  assert.strictEqual(resolvedAdminCompany, "UR");

  const calls = [];
  const pool = {
    request() {
      const inputs = [];
      const request = {
        input(name, _type, value) {
          inputs.push([name, value]);
          return request;
        },
        async query(query) {
          calls.push({ query, inputs: [...inputs] });
          if (query.includes("FROM Defaults")) {
            return { recordset: [{ FromDate: "2026-06-01" }] };
          }
          return { recordset: [{ VoucherNo: "V-1", Debit: 100 }] };
        },
      };
      return request;
    },
  };

  const snapshot = await loadAccountingSnapshot({
    pool,
    tenantId: "tenant-1",
    userId: "Cherrys",
    companyCode: "UR",
  });
  assert.strictEqual(snapshot.fromDate, "2026-06-01");
  assert.strictEqual(snapshot.rows.length, 1);
  assert.deepStrictEqual(calls[0].inputs, [["companyId", "UR"]]);
  assert.deepStrictEqual(calls[1].inputs.map(([name]) => name), [
    "fromDate",
    "toDate",
    "userId",
    "companyCode",
  ]);
  assert.strictEqual(calls[1].inputs.find(([name]) => name === "userId")[1], "Cherrys");
  assert.strictEqual(calls[1].inputs.find(([name]) => name === "companyCode")[1], "UR");
  console.log("Accounting sync contract tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
