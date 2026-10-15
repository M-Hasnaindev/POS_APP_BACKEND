const assert = require("node:assert/strict");
const { createAdminStore } = require("../services/adminStore");
const calls = [];
let next = [];
const pool = {
  request() {
    const params = {};
    return {
      input(k, t, v) {
        params[k] = v;
        return this;
      },
      async query(sql) {
        calls.push({ sql, params });
        return { recordset: next };
      },
    };
  },
};
(async () => {
  const store = createAdminStore(async () => pool);
  await store.checkAccess({
    tenantId: "tenant_A",
    companyCode: "C1",
    userId: "U1",
  });
  const c = calls.at(-1);
  assert.deepEqual(c.params, {
    tenantId: "tenant_A",
    companyCode: "C1",
    userId: "U1",
  });
  assert.match(c.sql, /TenantId=@tenantId/);
  assert.match(c.sql, /CompanyCode=@companyCode/);
  assert.match(c.sql, /UserId=@userId/);
  await store.checkAccess({
    tenantId: "tenant_B",
    companyCode: "C1",
    userId: "U1",
  });
  assert.equal(calls.at(-1).params.tenantId, "tenant_B");
  assert.equal(calls.filter((c) => c.sql.includes("CREATE TABLE")).length, 1);
  await store.createSession("raw-session-id", "admin@example.test", new Date());
  assert.notEqual(calls.at(-1).params.hash, "raw-session-id");
  assert.equal(calls.at(-1).params.hash.length, 64);
  await store.setRestriction(
    {
      tenantId: "t",
      companyCode: "c",
      userId: "u",
      scope: "user",
      restricted: true,
      reason: "test",
    },
    "admin",
  );
  assert.match(calls.at(-1).sql, /UPDLOCK,SERIALIZABLE/);
  assert.match(calls.at(-1).sql, /ROLLBACK TRANSACTION/);
  assert.match(
    calls[0].sql,
    /PRIMARY KEY\(Scope,TenantId,CompanyCode,UserId\)/,
  );
  assert.match(calls[0].sql, /sys.key_constraints/);
  assert.doesNotMatch(calls[0].sql, /DELETE FROM dbo.POSAdminRestrictions/);
  for (const scope of ["tenant", "company"]) {
    await store.setRestriction(
      {
        scope,
        tenantId: "t",
        companyCode: "",
        userId: "",
        restricted: true,
        reason: "test",
      },
      "admin",
    );
    assert.equal(calls.at(-1).params.scope, scope);
    assert.equal(calls.at(-1).params.companyCode, "");
    assert.match(calls.at(-1).sql, /WHERE Scope=@scope AND TenantId=@tenantId/);
  }
  await store.checkAccess({
    tenantId: "t",
    companyCode: "",
    userId: "default-user",
  });
  assert.equal(calls.at(-1).params.companyCode, "");
  assert.match(
    calls.at(-1).sql,
    /Scope='company' AND CompanyCode=@companyCode/,
  );
  console.log("Admin SQL scope and transaction tests passed (mock database).");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
