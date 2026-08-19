require("dotenv").config();

const { tenants } = require("../config/tenants");
const { getPoolForTenant, closeAllPools } = require("../config/db");

async function tableExists(db, tableName) {
  const result = await db.request()
    .input("tableName", tableName)
    .query("SELECT OBJECT_ID(@tableName, 'U') AS objectId");
  return Boolean(result.recordset[0]?.objectId);
}

async function diagnoseTenant(tenantId) {
  const db = await getPoolForTenant(tenantId);
  const hasTokens = await tableExists(db, "dbo.MobilePushTokens");
  const hasLogs = await tableExists(db, "dbo.MobileNotificationPushLog");
  const hasNotifications = await tableExists(db, "dbo.Notifications");
  const report = {
    tenantId,
    tables: {
      tokens: hasTokens,
      logs: hasLogs,
      notifications: hasNotifications,
    },
  };

  if (hasTokens) {
    const result = await db.request().query(`
      SELECT
        COUNT(*) AS totalDevices,
        SUM(CASE WHEN IsActive = 1 THEN 1 ELSE 0 END) AS activeDevices,
        SUM(CASE WHEN IsActive = 1 AND ExpoPushToken LIKE 'FCM:%' THEN 1 ELSE 0 END) AS activeFcmDevices,
        SUM(CASE WHEN IsActive = 1 AND LEFT(ExpoPushToken, 4) = 'Expo' THEN 1 ELSE 0 END) AS activeExpoDevices,
        MAX(LastSeenAt) AS lastSeenAt,
        MAX(LastPushCheckAt) AS lastPushCheckAt
      FROM dbo.MobilePushTokens
    `);
    report.devices = result.recordset[0];
  }

  if (hasLogs) {
    const result = await db.request().query(`
      SELECT
        COUNT(*) AS totalTickets,
        SUM(CASE WHEN ReceiptStatus = 'pending' THEN 1 ELSE 0 END) AS pendingReceipts,
        SUM(CASE WHEN ReceiptStatus = 'ok' THEN 1 ELSE 0 END) AS deliveredToProvider,
        SUM(CASE WHEN ReceiptStatus = 'error' THEN 1 ELSE 0 END) AS receiptErrors,
        MAX(SentAt) AS lastTicketAt,
        MAX(ReceiptCheckedAt) AS lastReceiptCheckedAt
      FROM dbo.MobileNotificationPushLog
    `);
    report.delivery = result.recordset[0];
  }

  if (hasNotifications) {
    const countResult = await db.request().query(
      "SELECT COUNT(*) AS totalNotifications FROM dbo.Notifications",
    );
    const columnResult = await db.request().query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Notifications'
      ORDER BY ORDINAL_POSITION
    `);
    report.notifications = {
      ...countResult.recordset[0],
      columns: columnResult.recordset.map((row) => row.COLUMN_NAME),
    };
  }

  return report;
}

async function main() {
  for (const tenant of tenants) {
    try {
      console.log(JSON.stringify(await diagnoseTenant(tenant.id), null, 2));
    } catch (error) {
      console.error(JSON.stringify({ tenantId: tenant.id, error: error.message }, null, 2));
    }
  }
}

main()
  .catch((error) => {
    console.error("Push diagnostics failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
