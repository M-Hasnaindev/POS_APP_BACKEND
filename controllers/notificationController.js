const crypto = require("crypto");
const { sql, getPoolForTenant } = require("../config/db");
const { tenants } = require("../config/tenants");
const { isDirectFcmToken, isFcmConfigured, sendFcmPush } = require("../services/fcmService");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const notificationSchemaCache = new WeakMap();
const notificationSupportTablesReady = new WeakMap();

function getValue(row, candidates) {
  if (!row || typeof row !== "object") return null;
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const key = keys.find((item) => item.toLowerCase() === candidate.toLowerCase());
    if (key && row[key] !== undefined && row[key] !== null) return row[key];
  }
  return null;
}

function text(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function normalizedPriority(value) {
  const raw = text(value).toLowerCase();
  if (["high", "h", "1", "urgent", "critical"].includes(raw)) return "high";
  if (["medium", "m", "2", "normal"].includes(raw)) return "medium";
  return "low";
}

function normalizedStatus(value) {
  const raw = text(value).toLowerCase();
  if (["read", "r", "1", "true", "y", "yes"].includes(raw)) return "read";
  return "unread";
}

function stableNotificationKey(row) {
  const identity = getValue(row, [
    "NotificationId",
    "NotificationID",
    "NotificationNo",
    "NotificationCode",
    "Id",
    "ID",
    "Code",
  ]);

  const source = identity !== null && text(identity)
    ? `id:${text(identity)}`
    : JSON.stringify(row, Object.keys(row || {}).sort());

  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 48);
}

function normalizeNotification(row) {
  const type = text(getValue(row, ["TypeText", "EventType", "Type", "NotificationType", "PageName", "Module", "Category"])) || "Notification";
  const title = text(getValue(row, ["PageTitle", "Title", "NotificationTitle", "Subject", "Heading"])) || type;
  const transactionNumber = text(getValue(row, [
    "TransactionNumber",
    "TransactionNo",
    "TranNo",
    "RefNo",
    "ReferenceNo",
    "DocumentNo",
  ]));
  const message = text(getValue(row, [
    "FullMessage",
    "NotificationMessage",
    "Message",
    "NotificationText",
    "Description",
    "Detail",
    "Details",
  ])) || (transactionNumber ? `${title} ${transactionNumber}` : title);
  const branchFrom = text(getValue(row, ["BranchFrom", "FromBranch", "FromBranchCode"]));
  const branchTo = text(getValue(row, ["BranchTo", "ToBranch", "ToBranchCode"]));
  const branch = text(getValue(row, ["BranchDisplay", "BranchName", "Branch", "BranchCode", "Location"]))
    || (branchFrom && branchTo ? `${branchFrom} → ${branchTo}` : branchTo || branchFrom);
  const priority = normalizedPriority(getValue(row, ["PriorityType", "NotifyType", "Priority", "PriorityName", "PriorityLevel"]));
  const status = normalizedStatus(getValue(row, ["ReadStatus", "Status", "IsRead", "NotificationStatus"]));
  const dateTime = getValue(row, [
    "DateTime",
    "NotificationDateTime",
    "CreatedDate",
    "CreatedAt",
    "EntryDate",
    "NotificationDate",
    "Date",
  ]);
  const time = getValue(row, ["Time", "EntryTime", "CreatedTime", "NotificationTime"]);
  const recipientUserId = text(getValue(row, [
    "UserId",
    "UserID",
    "ToUser",
    "ToUserId",
    "RecipientUserId",
    "RecipientUserID",
  ]));
  const rawId = text(getValue(row, [
    "NotificationId",
    "NotificationID",
    "NotificationNo",
    "NotificationCode",
    "Id",
    "ID",
    "Code",
  ]));
  const key = stableNotificationKey(row);

  // Keep the mobile payload deliberately small. Returning the complete raw SQL
  // row for every notification duplicated data and caused unnecessary JSON
  // parsing/memory work on the phone.
  return {
    id: rawId || key,
    key,
    type,
    title,
    message,
    transactionNumber,
    branch,
    priority,
    status,
    dateTime: dateTime ?? null,
    time: time ?? null,
    recipientUserId,
  };
}

function quoted(name) {
  return `[${String(name).replace(/]/g, "]]" )}]`;
}

function col(alias, name) {
  return alias ? `${alias}.${quoted(name)}` : quoted(name);
}

function firstColumn(columnMap, candidates) {
  for (const candidate of candidates) {
    const actual = columnMap.get(candidate.toLowerCase());
    if (actual) return actual;
  }
  return null;
}

async function getNotificationSchema(db) {
  const cached = notificationSchemaCache.get(db);
  if (cached) return cached;

  const result = await db.request().query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = 'Notifications'
  `);
  const columnMap = new Map(result.recordset.map((row) => [String(row.COLUMN_NAME).toLowerCase(), row.COLUMN_NAME]));

  const schema = {
    id: firstColumn(columnMap, ["NotificationID", "NotificationId", "NotificationNo", "NotificationCode", "ID", "Id", "Code"]),
    userId: firstColumn(columnMap, ["UserID", "UserId", "ToUser", "ToUserId", "RecipientUserID", "RecipientUserId"]),
    type: firstColumn(columnMap, ["TypeText", "EventType", "Type", "NotificationType", "PageName", "Module", "Category"]),
    title: firstColumn(columnMap, ["PageTitle", "Title", "NotificationTitle", "Subject", "Heading"]),
    message: firstColumn(columnMap, ["FullMessage", "NotificationMessage", "Message", "NotificationText", "Description", "Detail", "Details"]),
    transaction: firstColumn(columnMap, ["TransactionNumber", "TransactionNo", "TranNo", "RefNo", "ReferenceNo", "DocumentNo"]),
    branch: firstColumn(columnMap, ["BranchDisplay", "BranchName", "Branch", "BranchCode", "Location"]),
    branchFrom: firstColumn(columnMap, ["BranchFrom", "FromBranch", "FromBranchCode"]),
    branchTo: firstColumn(columnMap, ["BranchTo", "ToBranch", "ToBranchCode"]),
    priority: firstColumn(columnMap, ["PriorityType", "NotifyType", "Priority", "PriorityName", "PriorityLevel"]),
    status: firstColumn(columnMap, ["ReadStatus", "Status", "IsRead", "NotificationStatus"]),
    dateTime: firstColumn(columnMap, ["DateTime", "NotificationDateTime", "CreatedDate", "CreatedAt", "EntryDate", "NotificationDate", "Date"]),
    time: firstColumn(columnMap, ["Time", "EntryTime", "CreatedTime", "NotificationTime"]),
    readDate: firstColumn(columnMap, ["ReadDate", "ReadAt", "ReadDateTime"]),
  };

  notificationSchemaCache.set(db, schema);
  return schema;
}

function rawTextExpression(alias, columnName) {
  if (!columnName) return "''";
  return `LOWER(LTRIM(RTRIM(CONVERT(NVARCHAR(200), ${col(alias, columnName)}))))`;
}

function priorityExpression(alias, schema) {
  const raw = rawTextExpression(alias, schema.priority);
  return `CASE
    WHEN ${raw} IN ('high','h','1','urgent','critical') THEN 'high'
    WHEN ${raw} IN ('medium','m','2','normal') THEN 'medium'
    ELSE 'low'
  END`;
}

function statusExpression(alias, schema) {
  const raw = rawTextExpression(alias, schema.status);
  return `CASE
    WHEN ${raw} IN ('read','r','1','true','y','yes') THEN 'read'
    ELSE 'unread'
  END`;
}

function parseDateOnly(value) {
  const raw = text(value);
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addUserFilter(request, parts, schema, userId, alias = "N") {
  if (!schema.userId || !userId) return;
  request.input("userId", sql.NVarChar(100), String(userId));
  parts.push(`CAST(${col(alias, schema.userId)} AS NVARCHAR(100)) = @userId`);
}

function addListFilters(request, parts, schema, filters, alias = "N") {
  const search = text(filters.search);
  if (search) {
    const searchableColumns = Array.from(new Set([
      schema.title,
      schema.message,
      schema.type,
      schema.transaction,
      schema.branch,
      schema.branchFrom,
      schema.branchTo,
    ].filter(Boolean)));
    if (searchableColumns.length) {
      request.input("search", sql.NVarChar(500), `%${search}%`);
      parts.push(`(${searchableColumns.map((name) => `CONVERT(NVARCHAR(MAX), ${col(alias, name)}) LIKE @search`).join(" OR ")})`);
    }
  }

  const priority = text(filters.priority).toLowerCase();
  if (["high", "medium", "low"].includes(priority)) {
    request.input("priorityFilter", sql.NVarChar(20), priority);
    parts.push(`${priorityExpression(alias, schema)} = @priorityFilter`);
  }

  const status = text(filters.status).toLowerCase();
  if (["read", "unread"].includes(status)) {
    request.input("statusFilter", sql.NVarChar(20), status);
    parts.push(`${statusExpression(alias, schema)} = @statusFilter`);
  }

  const type = text(filters.type);
  if (type && schema.type) {
    request.input("typeFilter", sql.NVarChar(200), type);
    parts.push(`UPPER(LTRIM(RTRIM(CONVERT(NVARCHAR(200), ${col(alias, schema.type)})))) = UPPER(@typeFilter)`);
  }

  if (schema.dateTime) {
    const fromDate = parseDateOnly(filters.fromDate);
    if (fromDate) {
      request.input("fromDate", sql.DateTime2, fromDate);
      parts.push(`${col(alias, schema.dateTime)} >= @fromDate`);
    }

    const toDate = parseDateOnly(filters.toDate);
    if (toDate) {
      const exclusive = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);
      request.input("toDate", sql.DateTime2, exclusive);
      parts.push(`${col(alias, schema.dateTime)} < @toDate`);
    }
  }
}

function orderBy(schema, alias = "N") {
  const columns = [];
  if (schema.dateTime) columns.push(`${col(alias, schema.dateTime)} DESC`);
  if (schema.id) columns.push(`${col(alias, schema.id)} DESC`);
  return columns.length ? `ORDER BY ${columns.join(", ")}` : "ORDER BY (SELECT 0)";
}

async function loadNotificationPage(db, schema, userId, options = {}) {
  const page = Math.max(1, Number(options.page || 1));
  const pageSize = Math.max(1, Math.min(100, Number(options.pageSize || 30)));
  const offset = (page - 1) * pageSize;

  const dataRequest = db.request();
  const dataWhere = [];
  addUserFilter(dataRequest, dataWhere, schema, userId);
  addPreferenceFilters(dataWhere, schema, options.preferences);
  addListFilters(dataRequest, dataWhere, schema, options);
  dataRequest.input("offset", sql.Int, offset).input("pageSize", sql.Int, pageSize);

  const countRequest = db.request();
  const countWhere = [];
  addUserFilter(countRequest, countWhere, schema, userId);
  addPreferenceFilters(countWhere, schema, options.preferences);
  addListFilters(countRequest, countWhere, schema, options);

  const whereSql = dataWhere.length ? `WHERE ${dataWhere.join(" AND ")}` : "";
  const countWhereSql = countWhere.length ? `WHERE ${countWhere.join(" AND ")}` : "";

  const [dataResult, countResult] = await Promise.all([
    dataRequest.query(`
      SELECT N.*
      FROM dbo.Notifications N
      ${whereSql}
      ${orderBy(schema)}
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `),
    countRequest.query(`
      SELECT COUNT_BIG(1) AS Total
      FROM dbo.Notifications N
      ${countWhereSql}
    `),
  ]);

  const total = Number(countResult.recordset[0]?.Total || 0);
  const items = dataResult.recordset.map(normalizeNotification);

  return {
    items,
    page,
    pageSize,
    total,
    hasMore: offset + items.length < total,
  };
}

async function loadRecentNotifications(db, schema, userId, limit = 15, preferences = null) {
  const pageSize = Math.max(1, Math.min(30, Number(limit || 15)));
  const request = db.request();
  const parts = [];
  addUserFilter(request, parts, schema, userId);
  addPreferenceFilters(parts, schema, preferences);
  request.input("limit", sql.Int, pageSize);
  const whereSql = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  const result = await request.query(`
    SELECT TOP (@limit) N.*
    FROM dbo.Notifications N
    ${whereSql}
    ${orderBy(schema)}
  `);
  return result.recordset.map(normalizeNotification);
}

async function loadTypes(db, schema, userId) {
  if (!schema.type) return [];
  const request = db.request();
  const parts = [];
  addUserFilter(request, parts, schema, userId);
  parts.push(`${col("N", schema.type)} IS NOT NULL`);
  parts.push(`LTRIM(RTRIM(CONVERT(NVARCHAR(200), ${col("N", schema.type)}))) <> ''`);
  const whereSql = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  const result = await request.query(`
    SELECT DISTINCT TOP (100) LTRIM(RTRIM(CONVERT(NVARCHAR(200), ${col("N", schema.type)}))) AS TypeValue
    FROM dbo.Notifications N
    ${whereSql}
    ORDER BY TypeValue
  `);
  return result.recordset.map((row) => text(row.TypeValue)).filter(Boolean);
}

async function loadSummary(db, schema, userId, preferences = null) {
  const request = db.request();
  const parts = [];
  addUserFilter(request, parts, schema, userId);
  addPreferenceFilters(parts, schema, preferences);
  const whereSql = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  const priority = priorityExpression("N", schema);
  const status = statusExpression("N", schema);

  const result = await request.query(`
    SELECT
      COUNT_BIG(1) AS Total,
      SUM(CASE WHEN ${priority} = 'high' THEN 1 ELSE 0 END) AS HighCount,
      SUM(CASE WHEN ${priority} = 'medium' THEN 1 ELSE 0 END) AS MediumCount,
      SUM(CASE WHEN ${priority} = 'low' THEN 1 ELSE 0 END) AS LowCount,
      SUM(CASE WHEN ${status} = 'unread' THEN 1 ELSE 0 END) AS UnreadCount,
      SUM(CASE WHEN ${priority} = 'high' AND ${status} = 'unread' THEN 1 ELSE 0 END) AS UnreadHighCount
    FROM dbo.Notifications N
    ${whereSql}
  `);

  const row = result.recordset[0] || {};
  return {
    total: Number(row.Total || 0),
    high: Number(row.HighCount || 0),
    medium: Number(row.MediumCount || 0),
    low: Number(row.LowCount || 0),
    unread: Number(row.UnreadCount || 0),
    unreadHigh: Number(row.UnreadHighCount || 0),
  };
}


function defaultNotificationPreferences() {
  return {
    suppressAll: false,
    suppressHigh: false,
    suppressMedium: false,
    suppressLow: false,
  };
}

function normalizePreferences(row) {
  return {
    suppressAll: Boolean(row?.SuppressAll),
    suppressHigh: Boolean(row?.SuppressHigh),
    suppressMedium: Boolean(row?.SuppressMedium),
    suppressLow: Boolean(row?.SuppressLow),
  };
}

function addPreferenceFilters(parts, schema, preferences, alias = "N") {
  const prefs = preferences || defaultNotificationPreferences();
  if (prefs.suppressAll) {
    parts.push("1 = 0");
    return;
  }

  const blocked = [];
  if (prefs.suppressHigh) blocked.push("high");
  if (prefs.suppressMedium) blocked.push("medium");
  if (prefs.suppressLow) blocked.push("low");
  if (!blocked.length) return;

  const priority = priorityExpression(alias, schema);
  parts.push(`${priority} NOT IN (${blocked.map((value) => `'${value}'`).join(",")})`);
}

async function ensurePushTables(db) {
  const existingSetup = notificationSupportTablesReady.get(db);
  if (existingSetup) return existingSetup;

  const setupPromise = (async () => {
    // Step 1: create support tables if they do not already exist.
    await db.request().query(`
      IF OBJECT_ID('dbo.MobilePushTokens', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.MobilePushTokens (
          ExpoPushToken NVARCHAR(255) NOT NULL PRIMARY KEY,
          UserId NVARCHAR(100) NOT NULL,
          CompanyCode NVARCHAR(100) NULL,
          Platform NVARCHAR(30) NULL,
          IsActive BIT NOT NULL CONSTRAINT DF_MobilePushTokens_IsActive DEFAULT(1),
          RegisteredAt DATETIME2 NOT NULL CONSTRAINT DF_MobilePushTokens_RegisteredAt DEFAULT(GETDATE()),
          LastSeenAt DATETIME2 NOT NULL CONSTRAINT DF_MobilePushTokens_LastSeenAt DEFAULT(GETDATE()),
          PushFromDate DATETIME2 NULL,
          LastPushCheckAt DATETIME2 NULL
        );
      END;

      IF OBJECT_ID('dbo.MobileNotificationPushLog', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.MobileNotificationPushLog (
          NotificationKey NVARCHAR(64) NOT NULL,
          ExpoPushToken NVARCHAR(255) NOT NULL,
          UserId NVARCHAR(100) NOT NULL,
          SentAt DATETIME2 NOT NULL CONSTRAINT DF_MobileNotificationPushLog_SentAt DEFAULT(GETDATE()),
          ExpoTicketId NVARCHAR(100) NULL,
          ReceiptStatus NVARCHAR(20) NULL,
          ReceiptError NVARCHAR(100) NULL,
          ReceiptMessage NVARCHAR(1000) NULL,
          ReceiptCheckedAt DATETIME2 NULL,
          CONSTRAINT PK_MobileNotificationPushLog PRIMARY KEY (NotificationKey, ExpoPushToken)
        );
      END;

      IF OBJECT_ID('dbo.MobileNotificationPreferences', 'U') IS NULL
      BEGIN
        CREATE TABLE dbo.MobileNotificationPreferences (
          UserId NVARCHAR(100) NOT NULL,
          CompanyCode NVARCHAR(100) NOT NULL CONSTRAINT DF_MobileNotificationPreferences_Company DEFAULT(''),
          SuppressAll BIT NOT NULL CONSTRAINT DF_MobileNotificationPreferences_All DEFAULT(0),
          SuppressHigh BIT NOT NULL CONSTRAINT DF_MobileNotificationPreferences_High DEFAULT(0),
          SuppressMedium BIT NOT NULL CONSTRAINT DF_MobileNotificationPreferences_Medium DEFAULT(0),
          SuppressLow BIT NOT NULL CONSTRAINT DF_MobileNotificationPreferences_Low DEFAULT(0),
          UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_MobileNotificationPreferences_UpdatedAt DEFAULT(GETDATE()),
          CONSTRAINT PK_MobileNotificationPreferences PRIMARY KEY (UserId, CompanyCode)
        );
      END;
    `);

    // Step 2: add columns in their own SQL batch. SQL Server compiles a batch
    // before executing ALTER TABLE, so these must be added before any statement
    // in a later batch references them.
    await db.request().query(`
      IF COL_LENGTH('dbo.MobilePushTokens', 'PushFromDate') IS NULL
        ALTER TABLE dbo.MobilePushTokens ADD PushFromDate DATETIME2 NULL;

      IF COL_LENGTH('dbo.MobilePushTokens', 'LastPushCheckAt') IS NULL
        ALTER TABLE dbo.MobilePushTokens ADD LastPushCheckAt DATETIME2 NULL;

      IF COL_LENGTH('dbo.MobileNotificationPushLog', 'ExpoTicketId') IS NULL
        ALTER TABLE dbo.MobileNotificationPushLog ADD ExpoTicketId NVARCHAR(100) NULL;

      IF COL_LENGTH('dbo.MobileNotificationPushLog', 'ReceiptStatus') IS NULL
        ALTER TABLE dbo.MobileNotificationPushLog ADD ReceiptStatus NVARCHAR(20) NULL;

      IF COL_LENGTH('dbo.MobileNotificationPushLog', 'ReceiptError') IS NULL
        ALTER TABLE dbo.MobileNotificationPushLog ADD ReceiptError NVARCHAR(100) NULL;

      IF COL_LENGTH('dbo.MobileNotificationPushLog', 'ReceiptMessage') IS NULL
        ALTER TABLE dbo.MobileNotificationPushLog ADD ReceiptMessage NVARCHAR(1000) NULL;

      IF COL_LENGTH('dbo.MobileNotificationPushLog', 'ReceiptCheckedAt') IS NULL
        ALTER TABLE dbo.MobileNotificationPushLog ADD ReceiptCheckedAt DATETIME2 NULL;
    `);

    // Step 3: only reference the migrated columns after the ALTER batch finished.
    await db.request().query(`
      UPDATE dbo.MobilePushTokens
      SET PushFromDate = ISNULL(PushFromDate, RegisteredAt),
          LastPushCheckAt = ISNULL(LastPushCheckAt, ISNULL(PushFromDate, RegisteredAt))
      WHERE PushFromDate IS NULL OR LastPushCheckAt IS NULL;
    `);
  })().catch((error) => {
    notificationSupportTablesReady.delete(db);
    throw error;
  });

  notificationSupportTablesReady.set(db, setupPromise);
  return setupPromise;
}

async function loadNotificationPreferences(db, userId, companyCode) {
  await ensurePushTables(db);
  const result = await db.request()
    .input("userId", sql.NVarChar(100), String(userId || ""))
    .input("companyCode", sql.NVarChar(100), String(companyCode || ""))
    .query(`
      SELECT TOP (1) SuppressAll, SuppressHigh, SuppressMedium, SuppressLow
      FROM dbo.MobileNotificationPreferences
      WHERE UserId = @userId AND CompanyCode = @companyCode
    `);
  return result.recordset.length ? normalizePreferences(result.recordset[0]) : defaultNotificationPreferences();
}

async function saveNotificationPreferences(db, userId, companyCode, preferences) {
  await ensurePushTables(db);
  const prefs = { ...defaultNotificationPreferences(), ...(preferences || {}) };
  await db.request()
    .input("userId", sql.NVarChar(100), String(userId || ""))
    .input("companyCode", sql.NVarChar(100), String(companyCode || ""))
    .input("suppressAll", sql.Bit, prefs.suppressAll ? 1 : 0)
    .input("suppressHigh", sql.Bit, prefs.suppressHigh ? 1 : 0)
    .input("suppressMedium", sql.Bit, prefs.suppressMedium ? 1 : 0)
    .input("suppressLow", sql.Bit, prefs.suppressLow ? 1 : 0)
    .query(`
      MERGE dbo.MobileNotificationPreferences AS T
      USING (SELECT @userId AS UserId, @companyCode AS CompanyCode) AS S
        ON T.UserId = S.UserId AND T.CompanyCode = S.CompanyCode
      WHEN MATCHED THEN UPDATE SET
        SuppressAll = @suppressAll,
        SuppressHigh = @suppressHigh,
        SuppressMedium = @suppressMedium,
        SuppressLow = @suppressLow,
        UpdatedAt = GETDATE()
      WHEN NOT MATCHED THEN INSERT
        (UserId, CompanyCode, SuppressAll, SuppressHigh, SuppressMedium, SuppressLow, UpdatedAt)
        VALUES (@userId, @companyCode, @suppressAll, @suppressHigh, @suppressMedium, @suppressLow, GETDATE());
    `);
  return prefs;
}

exports.getRecentNotifications = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const schema = await getNotificationSchema(db);
    const limit = Math.max(1, Math.min(30, Number(req.query.limit || 15)));
    const preferences = await loadNotificationPreferences(db, req.user.userId, req.user.companyCode);
    const [data, summary] = await Promise.all([
      loadRecentNotifications(db, schema, req.user.userId, limit, preferences),
      loadSummary(db, schema, req.user.userId, preferences),
    ]);

    return res.json({
      success: true,
      data,
      summary,
      pagination: {
        page: 1,
        pageSize: limit,
        total: summary.total,
        hasMore: data.length < summary.total,
      },
    });
  } catch (err) {
    console.error("RECENT NOTIFICATIONS ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to load notifications" });
  }
};

exports.getNotifications = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const schema = await getNotificationSchema(db);
    const preferences = await loadNotificationPreferences(db, req.user.userId, req.user.companyCode);
    const options = {
      page: req.query.page,
      pageSize: req.query.pageSize,
      search: req.query.search,
      priority: req.query.priority,
      status: req.query.status,
      type: req.query.type,
      fromDate: req.query.fromDate,
      toDate: req.query.toDate,
      preferences,
    };

    const [pageResult, summary] = await Promise.all([
      loadNotificationPage(db, schema, req.user.userId, options),
      loadSummary(db, schema, req.user.userId, preferences),
    ]);
    const types = ["NEW", "EDIT", "DELETE", "DELETE ITEM"];

    return res.json({
      success: true,
      data: pageResult.items,
      summary,
      types,
      pagination: {
        page: pageResult.page,
        pageSize: pageResult.pageSize,
        total: pageResult.total,
        hasMore: pageResult.hasMore,
      },
    });
  } catch (err) {
    console.error("NOTIFICATIONS ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to load notifications" });
  }
};


exports.getNotificationPreferences = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const preferences = await loadNotificationPreferences(db, req.user.userId, req.user.companyCode);
    return res.json({ success: true, data: preferences });
  } catch (err) {
    console.error("GET NOTIFICATION PREFERENCES ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to load notification settings" });
  }
};

exports.updateNotificationPreferences = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const preferences = await saveNotificationPreferences(db, req.user.userId, req.user.companyCode, {
      suppressAll: Boolean(req.body?.suppressAll),
      suppressHigh: Boolean(req.body?.suppressHigh),
      suppressMedium: Boolean(req.body?.suppressMedium),
      suppressLow: Boolean(req.body?.suppressLow),
    });
    return res.json({ success: true, data: preferences });
  } catch (err) {
    console.error("UPDATE NOTIFICATION PREFERENCES ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to save notification settings" });
  }
};

exports.registerPushToken = async (req, res) => {
  try {
    const expoPushToken = text(req.body?.expoPushToken);
    const platform = text(req.body?.platform);
    if (!expoPushToken) {
      return res.status(400).json({ success: false, message: "Push token required" });
    }

    if (isDirectFcmToken(expoPushToken) && !isFcmConfigured()) {
      return res.status(503).json({
        success: false,
        message: "Direct FCM push is not configured on the server",
      });
    }

    const db = await getPoolForTenant(req.user.tenantId);
    await ensurePushTables(db);

    const existingResult = await db.request()
      .input("token", sql.NVarChar(255), expoPushToken)
      .query("SELECT UserId, IsActive FROM dbo.MobilePushTokens WHERE ExpoPushToken = @token");

    const existing = existingResult.recordset[0] || null;
    const sameActiveUser = existing
      && String(existing.UserId || "") === String(req.user.userId || "")
      && Boolean(existing.IsActive);
    const resetBaseline = sameActiveUser ? 0 : 1;

    await db.request()
      .input("token", sql.NVarChar(255), expoPushToken)
      .input("userId", sql.NVarChar(100), String(req.user.userId || ""))
      .input("companyCode", sql.NVarChar(100), String(req.user.companyCode || ""))
      .input("platform", sql.NVarChar(30), platform || null)
      .input("resetBaseline", sql.Bit, resetBaseline)
      .query(`
        MERGE dbo.MobilePushTokens AS T
        USING (SELECT @token AS ExpoPushToken) AS S
          ON T.ExpoPushToken = S.ExpoPushToken
        WHEN MATCHED THEN UPDATE SET
          UserId = @userId,
          CompanyCode = @companyCode,
          Platform = @platform,
          IsActive = 1,
          LastSeenAt = GETDATE(),
          PushFromDate = CASE WHEN @resetBaseline = 1 THEN GETDATE() ELSE ISNULL(T.PushFromDate, GETDATE()) END,
          LastPushCheckAt = CASE WHEN @resetBaseline = 1 THEN GETDATE() ELSE ISNULL(T.LastPushCheckAt, GETDATE()) END
        WHEN NOT MATCHED THEN INSERT
          (ExpoPushToken, UserId, CompanyCode, Platform, IsActive, RegisteredAt, LastSeenAt, PushFromDate, LastPushCheckAt)
          VALUES (@token, @userId, @companyCode, @platform, 1, GETDATE(), GETDATE(), GETDATE(), GETDATE());
      `);

    if (resetBaseline) {
      await db.request()
        .input("token", sql.NVarChar(255), expoPushToken)
        .query("DELETE FROM dbo.MobileNotificationPushLog WHERE ExpoPushToken = @token");
    }

    console.log(
      `PUSH DEVICE REGISTERED [${req.user.tenantId}] user=${String(req.user.userId || "")} platform=${platform || "unknown"}`,
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("REGISTER PUSH TOKEN ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to register push notifications" });
  }
};

exports.unregisterPushToken = async (req, res) => {
  try {
    const expoPushToken = text(req.body?.expoPushToken);
    if (!expoPushToken) return res.json({ success: true });

    const db = await getPoolForTenant(req.user.tenantId);
    await ensurePushTables(db);
    await db.request()
      .input("token", sql.NVarChar(255), expoPushToken)
      .input("userId", sql.NVarChar(100), String(req.user.userId || ""))
      .query(`
        UPDATE dbo.MobilePushTokens
        SET IsActive = 0, LastSeenAt = GETDATE()
        WHERE ExpoPushToken = @token AND UserId = @userId
      `);

    return res.json({ success: true });
  } catch (err) {
    console.error("UNREGISTER PUSH TOKEN ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to unregister push notifications" });
  }
};

exports.markNotificationRead = async (req, res) => {
  try {
    const notificationId = text(req.body?.notificationId);
    if (!notificationId) {
      return res.status(400).json({ success: false, message: "Notification id required" });
    }

    const db = await getPoolForTenant(req.user.tenantId);
    const schema = await getNotificationSchema(db);
    if (!schema.id || !schema.userId || !schema.status) {
      return res.status(500).json({ success: false, message: "Notification read fields are not configured" });
    }

    const setParts = [`${quoted(schema.status)} = 1`];
    if (schema.readDate) setParts.push(`${quoted(schema.readDate)} = GETDATE()`);

    await db.request()
      .input("notificationId", sql.NVarChar(100), notificationId)
      .input("userId", sql.NVarChar(100), String(req.user.userId || ""))
      .query(`
        UPDATE dbo.Notifications
        SET ${setParts.join(", ")}
        WHERE CAST(${quoted(schema.id)} AS NVARCHAR(100)) = @notificationId
          AND CAST(${quoted(schema.userId)} AS NVARCHAR(100)) = @userId
      `);

    return res.json({ success: true });
  } catch (err) {
    console.error("MARK NOTIFICATION READ ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to mark notification as read" });
  }
};

exports.markAllNotificationsRead = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const schema = await getNotificationSchema(db);
    if (!schema.userId || !schema.status) {
      return res.status(500).json({ success: false, message: "Notification read fields are not configured" });
    }

    const setParts = [`${quoted(schema.status)} = 1`];
    if (schema.readDate) setParts.push(`${quoted(schema.readDate)} = GETDATE()`);

    const result = await db.request()
      .input("userId", sql.NVarChar(100), String(req.user.userId || ""))
      .query(`
        UPDATE dbo.Notifications
        SET ${setParts.join(", ")}
        WHERE CAST(${quoted(schema.userId)} AS NVARCHAR(100)) = @userId
          AND ${statusExpression("", schema)} = 'unread'
      `);

    return res.json({ success: true, updated: Number(result.rowsAffected?.[0] || 0) });
  } catch (err) {
    console.error("MARK ALL NOTIFICATIONS READ ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to mark notifications as read" });
  }
};

function shouldSendToUser(notification, userId) {
  if (!notification.recipientUserId) return true;
  return notification.recipientUserId.toLowerCase() === String(userId || "").trim().toLowerCase();
}

async function sendExpoPush(messages) {
  if (!messages.length) return [];
  const results = [];
  const chunkSize = 100;

  for (let start = 0; start < messages.length; start += chunkSize) {
    const chunk = messages.slice(start, start + chunkSize);
    const response = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(chunk),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Expo push request failed (${response.status}): ${body.slice(0, 250)}`);
    }

    const body = await response.json();
    const tickets = Array.isArray(body?.data) ? body.data : [];
    for (let index = 0; index < chunk.length; index += 1) {
      results.push({
        message: chunk[index],
        provider: "expo",
        ticket: tickets[index] || {
          status: "error",
          message: "Expo push service returned no ticket for this message",
        },
      });
    }
  }

  return results;
}

async function sendPushMessages(messages) {
  if (!messages.length) return [];

  const combined = new Array(messages.length);
  const expoEntries = [];
  const fcmEntries = [];

  messages.forEach((message, index) => {
    if (isDirectFcmToken(message.to)) fcmEntries.push({ index, message });
    else expoEntries.push({ index, message });
  });

  if (expoEntries.length) {
    const expoResults = await sendExpoPush(expoEntries.map((entry) => entry.message));
    expoResults.forEach((result, position) => {
      combined[expoEntries[position].index] = result;
    });
  }

  if (fcmEntries.length) {
    const fcmResults = await sendFcmPush(fcmEntries.map((entry) => entry.message));
    fcmResults.forEach((result, position) => {
      combined[fcmEntries[position].index] = result;
    });
  }

  return combined;
}

async function fetchExpoReceipts(ticketIds) {
  if (!ticketIds.length) return {};
  const response = await fetch(EXPO_RECEIPTS_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids: ticketIds }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Expo receipt request failed (${response.status}): ${body.slice(0, 250)}`);
  }
  const body = await response.json();
  return body?.data && typeof body.data === "object" ? body.data : {};
}

async function reconcileExpoReceipts(db) {
  const pendingResult = await db.request().query(`
    SELECT TOP (1000) NotificationKey, ExpoPushToken, ExpoTicketId
    FROM dbo.MobileNotificationPushLog
    WHERE ReceiptStatus = 'pending'
      AND ExpoTicketId IS NOT NULL
      AND SentAt <= DATEADD(MINUTE, -1, GETDATE())
      AND SentAt >= DATEADD(HOUR, -24, GETDATE())
    ORDER BY SentAt ASC
  `);
  const pending = pendingResult.recordset;
  if (!pending.length) return { checked: 0, delivered: 0, failed: 0, invalidDevices: 0, errors: [] };

  const receipts = await fetchExpoReceipts(pending.map((row) => String(row.ExpoTicketId)));
  const resolved = pending.filter((row) => receipts[String(row.ExpoTicketId)]);
  const invalidTokens = new Set();
  const errors = [];
  const receiptUpdates = [];
  let delivered = 0;

  for (const row of resolved) {
    const receipt = receipts[String(row.ExpoTicketId)] || {};
    const status = receipt.status === "ok" ? "ok" : "error";
    const errorCode = text(receipt?.details?.error);
    const message = text(receipt?.message).slice(0, 1000);
    receiptUpdates.push({
      key: String(row.NotificationKey),
      token: String(row.ExpoPushToken),
      status,
      error: errorCode || null,
      message: message || null,
    });

    if (status === "ok") {
      delivered += 1;
    } else {
      errors.push({ code: errorCode || "ExpoReceiptError", message: message || "Push delivery failed" });
      if (errorCode === "DeviceNotRegistered") invalidTokens.add(String(row.ExpoPushToken));
    }
  }

  // SQL Server allows at most 2100 parameters. Update receipts in compact
  // batches so one cron run does not make hundreds of sequential DB calls.
  for (let start = 0; start < receiptUpdates.length; start += 300) {
    const chunk = receiptUpdates.slice(start, start + 300);
    const request = db.request();
    const rows = chunk.map((entry, index) => {
      request.input(`receiptKey${index}`, sql.NVarChar(64), entry.key);
      request.input(`receiptToken${index}`, sql.NVarChar(255), entry.token);
      request.input(`receiptStatus${index}`, sql.NVarChar(20), entry.status);
      request.input(`receiptError${index}`, sql.NVarChar(100), entry.error);
      request.input(`receiptMessage${index}`, sql.NVarChar(1000), entry.message);
      return `(@receiptKey${index}, @receiptToken${index}, @receiptStatus${index}, @receiptError${index}, @receiptMessage${index})`;
    });
    await request.query(`
      UPDATE target
      SET target.ReceiptStatus = source.ReceiptStatus,
          target.ReceiptError = source.ReceiptError,
          target.ReceiptMessage = source.ReceiptMessage,
          target.ReceiptCheckedAt = GETDATE()
      FROM dbo.MobileNotificationPushLog AS target
      INNER JOIN (VALUES ${rows.join(",")})
        AS source(NotificationKey, ExpoPushToken, ReceiptStatus, ReceiptError, ReceiptMessage)
        ON target.NotificationKey = source.NotificationKey
       AND target.ExpoPushToken = source.ExpoPushToken
    `);
  }

  if (invalidTokens.size) {
    const request = db.request();
    const parameters = Array.from(invalidTokens).map((token, index) => {
      request.input(`invalidReceiptToken${index}`, sql.NVarChar(255), token);
      return `@invalidReceiptToken${index}`;
    });
    await request.query(`
      UPDATE dbo.MobilePushTokens
      SET IsActive = 0, LastSeenAt = GETDATE()
      WHERE ExpoPushToken IN (${parameters.join(",")})
    `);
  }

  return {
    checked: resolved.length,
    delivered,
    failed: resolved.length - delivered,
    invalidDevices: invalidTokens.size,
    errors: errors.slice(0, 3),
  };
}

async function insertPushLogs(db, entries) {
  if (!entries.length) return;
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    const identity = `${entry.key}|${entry.token}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    unique.push(entry);
  }

  const chunkSize = 150;
  for (let start = 0; start < unique.length; start += chunkSize) {
    const chunk = unique.slice(start, start + chunkSize);
    const request = db.request();
    const rows = chunk.map((entry, index) => {
      request.input(`key${index}`, sql.NVarChar(64), entry.key);
      request.input(`token${index}`, sql.NVarChar(255), entry.token);
      request.input(`user${index}`, sql.NVarChar(100), entry.userId);
      request.input(`ticket${index}`, sql.NVarChar(100), entry.ticketId || null);
      request.input(`receiptStatus${index}`, sql.NVarChar(20), entry.receiptStatus || "pending");
      return `(@key${index}, @token${index}, @user${index}, @ticket${index}, @receiptStatus${index})`;
    });

    await request.query(`
      MERGE dbo.MobileNotificationPushLog AS target
      USING (VALUES ${rows.join(",")}) AS source(NotificationKey, ExpoPushToken, UserId, ExpoTicketId, ReceiptStatus)
        ON target.NotificationKey = source.NotificationKey
       AND target.ExpoPushToken = source.ExpoPushToken
      WHEN MATCHED THEN UPDATE SET
        UserId = source.UserId,
        SentAt = GETDATE(),
        ExpoTicketId = source.ExpoTicketId,
        ReceiptStatus = source.ReceiptStatus,
        ReceiptError = NULL,
        ReceiptMessage = NULL,
        ReceiptCheckedAt = CASE WHEN source.ReceiptStatus = 'ok' THEN GETDATE() ELSE NULL END
      WHEN NOT MATCHED THEN INSERT
        (NotificationKey, ExpoPushToken, UserId, SentAt, ExpoTicketId, ReceiptStatus, ReceiptCheckedAt)
      VALUES
        (source.NotificationKey, source.ExpoPushToken, source.UserId, GETDATE(), source.ExpoTicketId, source.ReceiptStatus,
         CASE WHEN source.ReceiptStatus = 'ok' THEN GETDATE() ELSE NULL END);
    `);
  }
}

async function processTenantPushes(tenantId) {
  const db = await getPoolForTenant(tenantId);
  await ensurePushTables(db);
  const receiptSummary = await reconcileExpoReceipts(db);
  const schema = await getNotificationSchema(db);

  const tokenResult = await db.request().query(`
    SELECT ExpoPushToken, UserId, CompanyCode, Platform,
           ISNULL(LastPushCheckAt, ISNULL(PushFromDate, RegisteredAt)) AS LastPushCheckAt
    FROM dbo.MobilePushTokens
    WHERE IsActive = 1
  `);
  const devices = tokenResult.recordset;
  if (!devices.length) return { tenantId, sent: 0, devices: 0, receipts: receiptSummary };

  const preferenceResult = await db.request().query(`
    SELECT UserId, CompanyCode, SuppressAll, SuppressHigh, SuppressMedium, SuppressLow
    FROM dbo.MobileNotificationPreferences
  `);
  const preferenceMap = new Map(
    preferenceResult.recordset.map((row) => [
      `${text(row.UserId).toLowerCase()}|${text(row.CompanyCode).toLowerCase()}`,
      normalizePreferences(row),
    ]),
  );

  const workerCutoff = new Date();
  let candidates = [];
  let logRows = [];

  if (schema.dateTime) {
    const oldestCheck = devices.reduce((oldest, device) => {
      const date = new Date(device.LastPushCheckAt || 0);
      if (Number.isNaN(date.getTime())) return oldest;
      return !oldest || date < oldest ? date : oldest;
    }, null);
    const overlapStart = new Date((oldestCheck?.getTime() || workerCutoff.getTime()) - 2 * 60 * 1000);

    const request = db.request()
      .input("since", sql.DateTime2, overlapStart)
      .input("until", sql.DateTime2, workerCutoff);
    const result = await request.query(`
      SELECT TOP (3000) N.*
      FROM dbo.Notifications N
      WHERE ${col("N", schema.dateTime)} >= @since
        AND ${col("N", schema.dateTime)} <= @until
      ${orderBy(schema)}
    `);
    candidates = result.recordset.map(normalizeNotification);

    const logs = await db.request()
      .input("since", sql.DateTime2, overlapStart)
      .query(`
        SELECT NotificationKey, ExpoPushToken
        FROM dbo.MobileNotificationPushLog
        WHERE SentAt >= @since
      `);
    logRows = logs.recordset;
  } else {
    // Safe fallback for unusual schemas without a date column. The query is
    // bounded so a cron run never scans/renders the entire notification history.
    const result = await db.request().query(`
      SELECT TOP (1000) N.*
      FROM dbo.Notifications N
      ${orderBy(schema)}
    `);
    candidates = result.recordset.map(normalizeNotification);
    const logs = await db.request().query(`
      SELECT NotificationKey, ExpoPushToken
      FROM dbo.MobileNotificationPushLog
    `);
    logRows = logs.recordset;
  }

  const alreadySent = new Set(logRows.map((row) => `${text(row.NotificationKey)}|${text(row.ExpoPushToken)}`));
  const messages = [];
  const pendingLogs = [];

  // Most Notifications rows are user-targeted. Index the bounded candidate set
  // once instead of checking every notification against every registered device.
  const broadcastCandidates = [];
  const candidatesByUser = new Map();
  for (const notification of candidates) {
    const recipient = text(notification.recipientUserId).toLowerCase();
    if (!recipient) {
      broadcastCandidates.push(notification);
      continue;
    }
    const bucket = candidatesByUser.get(recipient) || [];
    bucket.push(notification);
    candidatesByUser.set(recipient, bucket);
  }

  for (const device of devices) {
    const token = text(device.ExpoPushToken);
    const isExpoToken = /^Expo(nent)?PushToken\[.+\]$/.test(token);
    const isFcmToken = isDirectFcmToken(token);
    if (!isExpoToken && !isFcmToken) continue;
    const preferenceKey = `${text(device.UserId).toLowerCase()}|${text(device.CompanyCode).toLowerCase()}`;
    const preferences = preferenceMap.get(preferenceKey) || defaultNotificationPreferences();
    if (preferences.suppressAll) continue;
    const deviceCheckAt = new Date(device.LastPushCheckAt || 0);
    const effectiveCheckAt = Number.isNaN(deviceCheckAt.getTime()) ? new Date(0) : deviceCheckAt;

    const userCandidates = candidatesByUser.get(text(device.UserId).toLowerCase()) || [];
    const relevantCandidates = broadcastCandidates.length
      ? broadcastCandidates.concat(userCandidates)
      : userCandidates;

    for (const notification of relevantCandidates) {
      const notificationDate = notification.dateTime ? new Date(notification.dateTime) : null;
      if (notificationDate && !Number.isNaN(notificationDate.getTime())) {
        // Two-minute overlap is used in the SQL fetch, but each device only gets
        // rows newer than its own checkpoint unless a missing log requires retry.
        const dedupeKey = `${notification.key}|${token}`;
        if (notificationDate <= effectiveCheckAt && alreadySent.has(dedupeKey)) continue;
      }

      if (!shouldSendToUser(notification, device.UserId)) continue;
      if (notification.priority === "high" && preferences.suppressHigh) continue;
      if (notification.priority === "medium" && preferences.suppressMedium) continue;
      if (notification.priority === "low" && preferences.suppressLow) continue;
      const dedupeKey = `${notification.key}|${token}`;
      if (alreadySent.has(dedupeKey)) continue;

      messages.push({
        to: token,
        sound: "default",
        title: notification.title || "Notification",
        body: notification.message || notification.transactionNumber || "You have a new notification.",
        priority: notification.priority === "high" ? "high" : "default",
        channelId: "business_notifications",
        data: {
          type: "business_notification",
          route: "/notifications/page",
          notificationKey: notification.key,
          notificationId: notification.id,
          transactionNumber: notification.transactionNumber || "",
        },
      });
      pendingLogs.push({
        key: notification.key,
        token,
        userId: String(device.UserId || ""),
      });
    }
  }

  let sentCount = 0;
  let invalidDeviceCount = 0;
  let failedCount = 0;

  if (messages.length) {
    const deliveryResults = await sendPushMessages(messages);
    const successfulLogs = [];
    const invalidTokens = new Set();
    const retryableFailures = [];

    deliveryResults.forEach((result, index) => {
      const ticket = result?.ticket || {};
      const pending = pendingLogs[index];
      if (ticket.status === "ok") {
        if (pending) {
          successfulLogs.push({
            ...pending,
            ticketId: text(ticket.id) || null,
            receiptStatus: result?.provider === "fcm" ? "ok" : "pending",
          });
        }
        sentCount += 1;
        return;
      }

      failedCount += 1;
      const errorCode = text(ticket?.details?.error);
      const failure = {
        code: errorCode || "ExpoPushError",
        message: text(ticket?.message) || "Push delivery was rejected",
        token: pending?.token || text(result?.message?.to),
      };

      if (errorCode === "DeviceNotRegistered" && failure.token) {
        invalidTokens.add(failure.token);
      } else {
        retryableFailures.push(failure);
      }
    });

    await insertPushLogs(db, successfulLogs);

    if (invalidTokens.size) {
      const tokens = Array.from(invalidTokens);
      const request = db.request();
      const parameters = tokens.map((token, index) => {
        request.input(`invalidToken${index}`, sql.NVarChar(255), token);
        return `@invalidToken${index}`;
      });
      await request.query(`
        UPDATE dbo.MobilePushTokens
        SET IsActive = 0, LastSeenAt = GETDATE()
        WHERE ExpoPushToken IN (${parameters.join(",")})
      `);
      invalidDeviceCount = tokens.length;
    }

    if (retryableFailures.length) {
      const sample = retryableFailures
        .slice(0, 3)
        .map((item) => `${item.code}: ${item.message}`)
        .join(" | ");
      // Do not advance checkpoints for active devices. Successful rows are
      // deduplicated by MobileNotificationPushLog, while failed rows retry on
      // the next worker run instead of being silently lost.
      throw new Error(`Push delivery errors (${retryableFailures.length}): ${sample}`);
    }
  }

  // Advance the checkpoint only after active-device notifications have either
  // succeeded or invalid/uninstalled device tokens have been deactivated.
  await db.request()
    .input("cutoff", sql.DateTime2, workerCutoff)
    .query(`
      UPDATE dbo.MobilePushTokens
      SET LastPushCheckAt = @cutoff
      WHERE IsActive = 1
    `);

  return {
    tenantId,
    sent: sentCount,
    failed: failedCount,
    invalidDevices: invalidDeviceCount,
    devices: devices.length,
    checked: candidates.length,
    receipts: receiptSummary,
  };
}

exports.processPushNotifications = async (req, res) => {
  try {
    const secret = process.env.CRON_SECRET;
    const authHeader = String(req.headers.authorization || "");
    const userAgent = String(req.headers["user-agent"] || "");

    if (secret) {
      if (authHeader !== `Bearer ${secret}`) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
      }
    } else if (!userAgent.includes("vercel-cron/1.0")) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    // Tenant databases are independent, so process them concurrently. This
    // shortens Vercel cron duration without changing per-tenant delivery order.
    const results = await Promise.all(
      tenants.map(async (tenant) => {
        try {
          return await processTenantPushes(tenant.id);
        } catch (error) {
          console.error(`PUSH WORKER ERROR [${tenant.id}]:`, error.message);
          return { tenantId: tenant.id, sent: 0, error: error.message };
        }
      }),
    );

    return res.json({
      success: true,
      processedAt: new Date().toISOString(),
      results,
    });
  } catch (err) {
    console.error("PROCESS PUSH NOTIFICATIONS ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Unable to process push notifications" });
  }
};
