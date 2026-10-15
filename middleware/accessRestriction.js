const { adminStore } = require("../services/adminStore");
async function enforceAccess(identity, res, store = adminStore) {
  if (!Object.prototype.hasOwnProperty.call(identity, "companyCode")) {
    res
      .status(401)
      .json({
        success: false,
        code: "ACCESS_IDENTITY_REQUIRED",
        message: "Please sign in again.",
      });
    return false;
  }
  try {
    const restriction = await store.checkAccess(identity);
    if (restriction) {
      res
        .status(403)
        .json({
          success: false,
          code: "ACCESS_RESTRICTED",
          message:
            restriction.reason ||
            "Access has been restricted by the administrator.",
          restriction,
        });
      return false;
    }
    return true;
  } catch (error) {
    res
      .status(error.statusCode === 401 ? 401 : 503)
      .json({
        success: false,
        code:
          error.statusCode === 401
            ? "ACCESS_IDENTITY_REQUIRED"
            : "ACCESS_CHECK_UNAVAILABLE",
        message: "Access could not be verified. Please try again.",
      });
    return false;
  }
}
module.exports = { enforceAccess };
