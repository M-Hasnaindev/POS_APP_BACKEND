const { adminStore } = require("./adminStore");
// Worker-only access decision: identity comes from the stored device record.
async function pushAccess(tenantId, device, store = adminStore) {
  if (
    device.CompanyCode === undefined ||
    device.CompanyCode === null ||
    !device.UserId
  )
    return { allowed: false, unavailable: true };
  try {
    return {
      allowed: !(await store.checkAccess({
        tenantId,
        companyCode: device.CompanyCode,
        userId: device.UserId,
      })),
      unavailable: false,
    };
  } catch {
    return { allowed: false, unavailable: true };
  }
}
module.exports = { pushAccess };
