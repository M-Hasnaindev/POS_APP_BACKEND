const assert = require("node:assert/strict");
const { pushAccess } = require("../services/adminPushAccess");
(async () => {
  let identity;
  const device = { CompanyCode: "A", UserId: "7" };
  assert.deepEqual(
    await pushAccess("tenant_2", device, {
      checkAccess: async (i) => {
        identity = i;
        return null;
      },
    }),
    { allowed: true, unavailable: false },
  );
  assert.deepEqual(identity, {
    tenantId: "tenant_2",
    companyCode: "A",
    userId: "7",
  });
  assert.deepEqual(
    await pushAccess("tenant_2", device, {
      checkAccess: async () => ({ scope: "company" }),
    }),
    { allowed: false, unavailable: false },
  );
  assert.deepEqual(
    await pushAccess("tenant_2", device, {
      checkAccess: async () => {
        throw Error("offline");
      },
    }),
    { allowed: false, unavailable: true },
  );
  assert.deepEqual(
    await pushAccess(
      "tenant_2",
      { UserId: "7" },
      {
        checkAccess: async () => {
          throw Error("must not query");
        },
      },
    ),
    { allowed: false, unavailable: true },
  );
  console.log(
    "Push restriction guard tests passed. No notification transport invoked.",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
