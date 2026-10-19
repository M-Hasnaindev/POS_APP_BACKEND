// POS notification delivery no longer depends on admin restriction storage.
// Recipient identity and notification preferences remain enforced by the worker.
async function pushAccess(tenantId, device) {
  return {
    allowed: Boolean(tenantId && device && device.UserId),
    unavailable: false,
  };
}
module.exports = { pushAccess };
