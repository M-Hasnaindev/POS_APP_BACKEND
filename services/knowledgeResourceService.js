const crypto = require("crypto");
const { sql, getPoolForTenant } = require("../config/db");

const PACK_VERSION = "2026-09-26-v2";
const DEFAULT_PAGE_SIZE = 750;
const MAX_PAGE_SIZE = 1500;

function positiveEnvSeconds(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resourceRefreshPolicy() {
  return {
    preferredStrategy: "change_tracking",
    incrementalSeconds: positiveEnvSeconds("RESOURCE_INCREMENTAL_INTERVAL_SECONDS", 600),
    verifiedSnapshotSeconds: positiveEnvSeconds("RESOURCE_SNAPSHOT_INTERVAL_SECONDS", 86400),
    atomicPromotion: true,
  };
}

const APPROVED_TABLES = Object.freeze([
  "BranchFile", "StockRoom", "BarcodeView", "PosPurchaseM", "PosPurchaseD",
  "PosPReturnM", "PosPReturnD", "PosTransferM", "PosTransferD",
  "PosStockTakeM", "PosStockTakeD", "PosStockAdjM", "PosStockAdjD",
  "UnPosMaster", "UnPosDetail", "UnPosPayment", "PosMaster", "PosDetail",
  "PosPayment", "PosBarOpen", "AccountList", "Employee",
  "PosBranchIncentive", "PosSalesmanIncentive", "PosCategoryIncentive",
  "PosCategoryWiseSalesmanIncentive", "PosMasterFile", "PosDetailFile",
  "PosTargetMaster", "PosTargetDetail", "PosIdMap", "PosDiscount",
]);

const PRIORITY = new Map(APPROVED_TABLES.map((name, index) => [name.toLowerCase(), index]));
const catalogCache = new Map();

function identifier(value) {
  return `[${String(value).replaceAll("]", "]]" )}]`;
}

function canonicalTableName(value) {
  const requested = String(value || "").trim().toLowerCase();
  const name = APPROVED_TABLES.find((item) => item.toLowerCase() === requested);
  if (!name) {
    const error = new Error("This table is not part of the approved resource pack");
    error.status = 404;
    throw error;
  }
  return name;
}

function schemaHash(resources) {
  const canonical = resources.map((table) => ({
    name: table.name,
    objectType: table.objectType,
    columns: table.columns.map((column) => [column.name, column.formattedType, column.isNullable]),
  }));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 20);
}

async function readCatalog(tenantId, force = false) {
  const cached = catalogCache.get(tenantId);
  if (!force && cached && Date.now() - cached.createdAt < 5 * 60 * 1000) return cached.value;

  const pool = await getPoolForTenant(tenantId);
  const names = APPROVED_TABLES.map((_, index) => `@name${index}`).join(",");
  const request = pool.request();
  APPROVED_TABLES.forEach((name, index) => request.input(`name${index}`, sql.NVarChar(128), name));
  request.timeout = 90000;
  const result = await request.query(`
    SELECT
      s.name AS SchemaName,
      o.name AS ObjectName,
      CASE WHEN o.type = 'V' THEN 'VIEW' ELSE 'TABLE' END AS ObjectType,
      c.column_id AS Ordinal,
      c.name AS ColumnName,
      t.name AS DataType,
      c.max_length AS MaxLength,
      c.precision AS PrecisionValue,
      c.scale AS ScaleValue,
      c.is_nullable AS IsNullable,
      c.is_identity AS IsIdentity,
      CASE WHEN pk.column_id IS NULL THEN 0 ELSE 1 END AS IsPrimaryKey,
      CASE WHEN ct.object_id IS NULL THEN 0 ELSE 1 END AS IsChangeTracked,
      COALESCE(rowsInfo.EstimatedRows, 0) AS EstimatedRows
    FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id = o.schema_id
    JOIN sys.columns c ON c.object_id = o.object_id
    JOIN sys.types t ON t.user_type_id = c.user_type_id
    LEFT JOIN sys.change_tracking_tables ct ON ct.object_id = o.object_id
    OUTER APPLY (
      SELECT TOP (1) ic.column_id
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      WHERE i.object_id = o.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
    ) pk
    OUTER APPLY (
      SELECT SUM(p.rows) AS EstimatedRows
      FROM sys.partitions p
      WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)
    ) rowsInfo
    WHERE o.type IN ('U', 'V') AND o.name IN (${names})
    ORDER BY o.name, c.column_id
  `);

  const grouped = new Map();
  for (const row of result.recordset || []) {
    const key = String(row.ObjectName).toLowerCase();
    if (!grouped.has(key)) {
      grouped.set(key, {
        schema: row.SchemaName,
        name: row.ObjectName,
        objectType: row.ObjectType,
        estimatedRows: Number(row.EstimatedRows || 0),
        priority: PRIORITY.get(key) ?? 999,
        changeTrackingEnabled: Boolean(row.IsChangeTracked),
        columns: [],
      });
    }
    const formattedType = ["varchar", "nvarchar", "char", "nchar", "binary", "varbinary"]
      .includes(String(row.DataType).toLowerCase())
      ? `${row.DataType}(${Number(row.MaxLength) === -1 ? "MAX" : Number(row.MaxLength)})`
      : ["decimal", "numeric"].includes(String(row.DataType).toLowerCase())
        ? `${row.DataType}(${row.PrecisionValue},${row.ScaleValue})`
        : row.DataType;
    grouped.get(key).columns.push({
      ordinal: Number(row.Ordinal), name: row.ColumnName, dataType: row.DataType,
      formattedType, isNullable: Boolean(row.IsNullable),
      isIdentity: Boolean(row.IsIdentity), isPrimaryKey: Boolean(row.IsPrimaryKey),
    });
  }

  const resources = APPROVED_TABLES.map((name) => grouped.get(name.toLowerCase()) || {
    schema: "dbo", name, objectType: "UNAVAILABLE", estimatedRows: 0,
    priority: PRIORITY.get(name.toLowerCase()) ?? 999, changeTrackingEnabled: false, columns: [],
  });
  const value = { resources, schemaHash: schemaHash(resources) };
  catalogCache.set(tenantId, { createdAt: Date.now(), value });
  return value;
}

function scopeFor(table, branchFile, companyCode, allowedBranches = [], isAdmin = false) {
  const lookup = new Map(table.columns.map((column) => [String(column.name).toLowerCase(), column.name]));
  const companyColumn = ["companycode", "compcode", "company"].map((key) => lookup.get(key)).find(Boolean);
  const clauses = [];
  let bind = false;
  if (companyCode && companyColumn) { clauses.push(`LTRIM(RTRIM(src.${identifier(companyColumn)})) = @companyCode`); bind = true; }

  const branchLookup = new Map((branchFile?.columns || []).map((column) => [String(column.name).toLowerCase(), column.name]));
  const branchFileCode = ["branchcode", "branch"].map((key) => branchLookup.get(key)).find(Boolean);
  const branchFileCompany = ["companycode", "compcode", "company"].map((key) => branchLookup.get(key)).find(Boolean);
  const sourceBranches = ["branchcode", "branch", "frombranch", "tobranch"]
    .map((key) => lookup.get(key)).filter(Boolean);
  if (companyCode && !companyColumn && branchFileCode && branchFileCompany && sourceBranches.length) {
    const matches = sourceBranches.map((column) => `LTRIM(RTRIM(bf.${identifier(branchFileCode)})) = LTRIM(RTRIM(src.${identifier(column)}))`).join(" OR ");
    clauses.push(`EXISTS (SELECT 1 FROM ${identifier(branchFile.schema)}.${identifier(branchFile.name)} bf WHERE LTRIM(RTRIM(bf.${identifier(branchFileCompany)})) = @companyCode AND (${matches}))`); bind = true;
  }
  const safeBranches = isAdmin ? [] : allowedBranches.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 200);
  if (safeBranches.length) {
    const direct = table.name.toLowerCase() === "branchfile" ? [lookup.get("branchcode")].filter(Boolean) : sourceBranches;
    if (direct.length) clauses.push(`(${direct.map((column) => `LTRIM(RTRIM(src.${identifier(column)})) IN (${safeBranches.map((_,index)=>`@branch${index}`).join(",")})`).join(" OR ")})`);
  }
  return { clause: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", bind, branches: safeBranches };
}

function orderColumns(table) {
  const primary = table.columns.filter((column) => column.isPrimaryKey);
  if (primary.length) return primary;
  const excluded = new Set(["text", "ntext", "image", "xml", "geography", "geometry", "hierarchyid"]);
  return table.columns.filter((column) => !excluded.has(String(column.dataType).toLowerCase())).slice(0, 4);
}

async function getManifest({ tenantId, companyCode, allowedBranches = [], isAdmin = false, force = false }) {
  const catalog = await readCatalog(tenantId, force);
  const capturedAt = new Date().toISOString();
  const pool = await getPoolForTenant(tenantId);
  const changeVersionResult = await pool.request().query("SELECT CHANGE_TRACKING_CURRENT_VERSION() AS CurrentVersion");
  const changeTrackingVersion = Number(changeVersionResult.recordset?.[0]?.CurrentVersion || 0);
  return {
    version: `${PACK_VERSION}-${catalog.schemaHash}-${crypto.createHash("sha256").update(JSON.stringify({companyCode,allowedBranches:[...allowedBranches].sort(),isAdmin})).digest("hex").slice(0,8)}`,
    snapshotId: crypto.createHash("sha256").update(`${tenantId}|${companyCode}|${PACK_VERSION}|${catalog.schemaHash}`).digest("hex").slice(0, 24),
    capturedAt,
    changeTrackingVersion,
    schemaHash: catalog.schemaHash,
    companyCode: String(companyCode || "").trim(),
    refreshPolicy: resourceRefreshPolicy(),
    requiredCount: APPROVED_TABLES.length,
    resources: catalog.resources.map((item) => ({ ...item, syncStrategy: item.changeTrackingEnabled && item.columns.some((column) => column.isPrimaryKey) ? "change_tracking" : "verified_snapshot" })),
    unavailable: catalog.resources.filter((item) => item.objectType === "UNAVAILABLE").map((item) => item.name),
  };
}

async function getResourceChanges({ tenantId, companyCode, allowedBranches = [], isAdmin = false, tableName, watermark }) {
  const canonical = canonicalTableName(tableName);
  const catalog = await readCatalog(tenantId, false);
  const table = catalog.resources.find((item) => item.name.toLowerCase() === canonical.toLowerCase());
  const primary = (table?.columns || []).filter((column) => column.isPrimaryKey);
  if (!isAdmin && allowedBranches.length) return { strategy:"verified_snapshot",resetRequired:false,watermark:null,upserts:[],deletedIds:[],reason:"Restricted branch scopes use atomic verified snapshots so deleted rows cannot cross permission boundaries" };
  if (!table || table.objectType !== "TABLE" || !table.changeTrackingEnabled || !primary.length) {
    return { strategy: "verified_snapshot", resetRequired: false, watermark: null, upserts: [], deletedIds: [], reason: "SQL Server Change Tracking is not enabled for this resource" };
  }
  const previous = Math.max(0, Number.parseInt(watermark, 10) || 0);
  const pool = await getPoolForTenant(tenantId);
  const versionResult = await pool.request().query(`SELECT CHANGE_TRACKING_CURRENT_VERSION() CurrentVersion, CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('${table.schema.replaceAll("'", "''")}.${table.name.replaceAll("'", "''")}')) MinVersion`);
  const current = Number(versionResult.recordset?.[0]?.CurrentVersion || 0);
  const minimum = Number(versionResult.recordset?.[0]?.MinVersion || 0);
  if (previous && previous < minimum) return { strategy: "change_tracking", resetRequired: true, watermark: current, upserts: [], deletedIds: [], reason: "Saved watermark is older than SQL Server retention" };
  const join = primary.map((column) => `src.${identifier(column.name)} = ch.${identifier(column.name)}`).join(" AND ");
  const keyFields = primary.map((column) => `ch.${identifier(column.name)} AS ${identifier(`__key_${column.name}`)}`).join(",");
  const fields = table.columns.map((column) => `src.${identifier(column.name)}`).join(",");
  const request = pool.request().input("watermark", sql.BigInt, previous);
  request.timeout = Math.max(30000, Math.min(Number(process.env.RESOURCE_SQL_TIMEOUT_MS || 120000), 240000));
  const result = await request.query(`SELECT TOP (10001) ch.SYS_CHANGE_VERSION AS __version,ch.SYS_CHANGE_OPERATION AS __operation,${keyFields},${fields} FROM CHANGETABLE(CHANGES ${identifier(table.schema)}.${identifier(table.name)}, @watermark) ch LEFT JOIN ${identifier(table.schema)}.${identifier(table.name)} src ON ${join} ORDER BY ch.SYS_CHANGE_VERSION`);
  const records = result.recordset || [];
  if (records.length > 10000) return { strategy: "change_tracking", resetRequired: true, watermark: current, upserts: [], deletedIds: [], reason: "Change set is too large for an incremental transaction" };
  const upserts = [], deletedIds = [];
  for (const record of records) {
    const keys = Object.fromEntries(primary.map((column) => [column.name, record[`__key_${column.name}`]]));
    if (record.__operation === "D") deletedIds.push(keys);
    else upserts.push(Object.fromEntries(table.columns.map((column) => [column.name, record[column.name]])));
  }
  return { strategy: "change_tracking", resetRequired: false, watermark: current, upserts, deletedIds, checksum: crypto.createHash("sha256").update(JSON.stringify({ upserts, deletedIds })).digest("hex") };
}

async function getResourcePage({ tenantId, companyCode, allowedBranches = [], isAdmin = false, tableName, page, pageSize }) {
  const canonical = canonicalTableName(tableName);
  const catalog = await readCatalog(tenantId, false);
  const table = catalog.resources.find((item) => item.name.toLowerCase() === canonical.toLowerCase());
  if (!table || table.objectType === "UNAVAILABLE" || !table.columns.length) {
    return { version: `${PACK_VERSION}-${catalog.schemaHash}`, table, page: 1, pageSize: 0, totalRows: 0, hasMore: false, rows: [], checksum: crypto.createHash("sha256").update("[]").digest("hex") };
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.max(100, Math.min(Number.parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const offset = (safePage - 1) * safePageSize;
  const order = orderColumns(table);
  const orderBy = order.length ? order.map((column) => identifier(column.name)).join(",") : "(SELECT NULL)";
  const fields = table.columns.map((column) => identifier(column.name)).join(",");
  const branchFile = catalog.resources.find((item) => item.name.toLowerCase() === "branchfile");
  const scope = scopeFor(table, branchFile, companyCode, allowedBranches, isAdmin);
  const pool = await getPoolForTenant(tenantId);
  const request = pool.request()
    .input("offset", sql.BigInt, offset)
    .input("take", sql.Int, safePageSize + 1);
  if (scope.bind) request.input("companyCode", sql.NVarChar(30), String(companyCode).trim());
  scope.branches.forEach((value,index)=>request.input(`branch${index}`,sql.NVarChar(30),value));
  request.timeout = Math.max(30000, Math.min(Number(process.env.RESOURCE_SQL_TIMEOUT_MS || 120000), 240000));
  const result = await request.query(`
    SELECT ${fields}
    FROM ${identifier(table.schema)}.${identifier(table.name)} AS src
    ${scope.clause}
    ORDER BY ${orderBy}
    OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY
  `);
  const received = result.recordset || [];
  const hasMore = received.length > safePageSize;
  const rows = hasMore ? received.slice(0, safePageSize) : received;
  return {
    version: `${PACK_VERSION}-${catalog.schemaHash}`, table, page: safePage,
    pageSize: safePageSize, hasMore, rows, rowCount: rows.length,
    totalRows: hasMore ? null : offset + rows.length,
    checksum: crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
  };
}

module.exports = { APPROVED_TABLES, PACK_VERSION, getManifest, getResourceChanges, getResourcePage, resourceRefreshPolicy };
