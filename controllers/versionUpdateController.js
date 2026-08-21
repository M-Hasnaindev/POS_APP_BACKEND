const { sql, getDefaultPool } = require("../config/db");

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

    const db = await getDefaultPool();
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
      `[VersionUpdates] app=${appName} installed=${appVersion} latest=${latestVersion} forceUpdate=${forceUpdate}`,
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
