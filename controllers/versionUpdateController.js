const jwt = require("jsonwebtoken");
const { sql, getPoolForTenant } = require("../config/db");
const { getTenantById } = require("../config/tenants");

function resolveTenantId(req) {
  const authorization = String(req.headers?.authorization || "").trim();
  const accessToken = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  const tenantToken = String(req.headers?.["x-tenant-token"] || "").trim();
  for (const token of [tenantToken, accessToken]) {
    if (!token) continue;
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (!["access", "tenant"].includes(payload?.type) || !payload?.tenantId) continue;
      const tenantId = getTenantById(payload.tenantId)?.id;
      if (tenantId) return tenantId;
    } catch {
      // An expired company token can coexist with a still-valid access token.
    }
  }
  return null;
}

exports.checkAppVersion = async (req, res) => {
  try {
    const appName = String(req.query?.AppName || "").trim();
    const appVersion = String(req.query?.AppVersion || "").trim();

    if (!appName || !appVersion) {
      return res.status(400).json({
        success: false,
        message: "AppName and AppVersion are required",
      });
    }

    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        message: "A valid company session is required",
      });
    }

    const db = await getPoolForTenant(tenantId);
    const result = await db.request()
      .input("AppName", sql.VarChar(150), appName)
      .query(`
        SELECT TOP 1 AppName, AppVersion, AppLink
        FROM dbo.AppInfo
        WHERE AppName = @AppName
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        message: "App not found in database",
      });
    }

    const dbApp = result.recordset[0];
    const latestVersion = String(dbApp.AppVersion ?? "").trim();
    const updateUrl = String(dbApp.AppLink ?? "").trim();
    const forceUpdate = latestVersion !== appVersion;

    console.log(
      `[VersionUpdates] tenant=${tenantId} app=${appName} installed=${appVersion} latest=${latestVersion} forceUpdate=${forceUpdate}`,
    );

    return res.json({
      success: true,
      forceUpdate,
      latestVersion,
      updateUrl,
      message: forceUpdate
        ? "A new version is available. Please update your app to continue."
        : "App is up to date",
    });
  } catch (err) {
    console.error("[VersionUpdates] App version check failed:", err);
    return res.status(500).json({
      success: false,
      message: "Unable to check the app version",
    });
  }
};
