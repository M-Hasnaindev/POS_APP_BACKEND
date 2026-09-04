const fs = require("fs");
const os = require("os");
const path = require("path");
const { sql, getPoolForTenant } = require("../config/db");
const { getTenantById } = require("../config/tenants");

const catalogCache = new Map();
const catalogPromises = new Map();
const CATALOG_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ROWS = 200;

function safeTenantName(tenantId) {
  return String(tenantId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function resolveTenantLogDirectory(tenantId) {
  const configured = String(process.env.AI_LOG_DIR || "").trim();
  const preferredRoot = configured || path.join(process.cwd(), "logs", "ai");
  const preferred = path.join(preferredRoot, safeTenantName(tenantId));
  try {
    await fs.promises.mkdir(preferred, { recursive: true });
    return preferred;
  } catch (error) {
    const fallback = path.join(
      os.tmpdir(),
      "cherry-pos-ai",
      safeTenantName(tenantId),
    );
    await fs.promises.mkdir(fallback, { recursive: true });
    console.warn("[AI POS][Files] Using temporary log directory", {
      preferred,
      fallback,
      reason: error.message,
    });
    return fallback;
  }
}

function formatSqlType(column) {
  const type = String(column.DataType || "unknown");
  const lower = type.toLowerCase();
  if (["varchar", "nvarchar", "char", "nchar", "binary", "varbinary"].includes(lower)) {
    const maxLength = Number(column.MaxLength);
    const divisor = lower.startsWith("n") ? 2 : 1;
    const length = maxLength === -1 ? "MAX" : Math.floor(maxLength / divisor);
    return `${type}(${length})`;
  }
  if (["decimal", "numeric"].includes(lower)) {
    return `${type}(${column.PrecisionValue},${column.ScaleValue})`;
  }
  return type;
}

function buildCatalogText(catalog) {
  const lines = [
    "CHERRY POS DATABASE CATALOG",
    `Generated: ${catalog.generatedAt}`,
    `Tenant: ${catalog.tenantId}`,
    `Available user tables/views: ${catalog.tables.length}`,
    "",
    "This file contains schema metadata only. Transaction rows are read on demand.",
    "",
  ];

  for (const table of catalog.tables) {
    lines.push("=".repeat(88));
    lines.push(`${table.schema}.${table.name} (${table.objectType})`);
    lines.push(`Estimated rows: ${Number(table.estimatedRows || 0).toLocaleString()}`);
    lines.push("Columns:");
    for (const column of table.columns) {
      const flags = [
        column.isPrimaryKey ? "PRIMARY KEY" : "",
        column.isIdentity ? "IDENTITY" : "",
        column.isNullable ? "NULL" : "NOT NULL",
      ].filter(Boolean);
      lines.push(
        `  ${String(column.ordinal).padStart(3, " ")}. ${column.name} : ${column.formattedType} [${flags.join(", ")}]`,
      );
    }
    lines.push("Indexes:");
    if (table.indexes.length === 0) lines.push("  (none reported)");
    for (const index of table.indexes) {
      lines.push(
        `  ${index.name} (${index.isUnique ? "UNIQUE; " : ""}${index.type}) -> ${index.columns.join(", ")}`,
      );
    }
    lines.push("Relationships:");
    if (table.relationships.length === 0) lines.push("  (none reported)");
    for (const relation of table.relationships) {
      lines.push(
        `  ${relation.name}: ${relation.parentTable}.${relation.parentColumn} -> ${relation.referencedTable}.${relation.referencedColumn}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function loadCatalogFromDatabase(tenantId) {
  const db = await getPoolForTenant(tenantId);
  console.log("[AI POS][Catalog] Reading database metadata", {
    tenantId,
    scope: "all user tables and views in selected tenant database",
  });

  const [columnResult, indexResult, relationshipResult, countResult] = await Promise.all([
    db.request().query(`
      SELECT
        S.name AS SchemaName,
        O.name AS ObjectName,
        O.type_desc AS ObjectType,
        C.column_id AS Ordinal,
        C.name AS ColumnName,
        T.name AS DataType,
        C.max_length AS MaxLength,
        C.precision AS PrecisionValue,
        C.scale AS ScaleValue,
        C.is_nullable AS IsNullable,
        C.is_identity AS IsIdentity,
        CASE WHEN PK.column_id IS NULL THEN 0 ELSE 1 END AS IsPrimaryKey
      FROM sys.objects O
      INNER JOIN sys.schemas S ON S.schema_id = O.schema_id
      INNER JOIN sys.columns C ON C.object_id = O.object_id
      INNER JOIN sys.types T ON T.user_type_id = C.user_type_id
      LEFT JOIN (
        SELECT IC.object_id, IC.column_id
        FROM sys.indexes I
        INNER JOIN sys.index_columns IC
          ON IC.object_id = I.object_id AND IC.index_id = I.index_id
        WHERE I.is_primary_key = 1
      ) PK ON PK.object_id = C.object_id AND PK.column_id = C.column_id
      WHERE O.type IN ('U', 'V') AND O.is_ms_shipped = 0
      ORDER BY S.name, O.name, C.column_id
    `),
    db.request().query(`
      SELECT
        S.name AS SchemaName,
        O.name AS ObjectName,
        I.name AS IndexName,
        I.type_desc AS IndexType,
        I.is_unique AS IsUnique,
        IC.key_ordinal AS KeyOrdinal,
        C.name AS ColumnName
      FROM sys.objects O
      INNER JOIN sys.schemas S ON S.schema_id = O.schema_id
      INNER JOIN sys.indexes I ON I.object_id = O.object_id
      INNER JOIN sys.index_columns IC
        ON IC.object_id = I.object_id AND IC.index_id = I.index_id
      INNER JOIN sys.columns C
        ON C.object_id = IC.object_id AND C.column_id = IC.column_id
      WHERE O.type IN ('U', 'V')
        AND O.is_ms_shipped = 0
        AND I.name IS NOT NULL
        AND IC.is_included_column = 0
      ORDER BY O.name, I.name, IC.key_ordinal
    `),
    db.request().query(`
      SELECT
        FK.name AS RelationshipName,
        PS.name AS ParentSchema,
        PO.name AS ParentTable,
        PC.name AS ParentColumn,
        RS.name AS ReferencedSchema,
        RO.name AS ReferencedTable,
        RC.name AS ReferencedColumn
      FROM sys.foreign_keys FK
      INNER JOIN sys.foreign_key_columns FKC ON FKC.constraint_object_id = FK.object_id
      INNER JOIN sys.objects PO ON PO.object_id = FKC.parent_object_id
      INNER JOIN sys.schemas PS ON PS.schema_id = PO.schema_id
      INNER JOIN sys.columns PC
        ON PC.object_id = FKC.parent_object_id AND PC.column_id = FKC.parent_column_id
      INNER JOIN sys.objects RO ON RO.object_id = FKC.referenced_object_id
      INNER JOIN sys.schemas RS ON RS.schema_id = RO.schema_id
      INNER JOIN sys.columns RC
        ON RC.object_id = FKC.referenced_object_id AND RC.column_id = FKC.referenced_column_id
      WHERE PO.is_ms_shipped = 0 AND RO.is_ms_shipped = 0
      ORDER BY PO.name, FK.name, FKC.constraint_column_id
    `),
    db.request().query(`
      SELECT S.name AS SchemaName, O.name AS ObjectName,
        COALESCE(SUM(P.rows), 0) AS EstimatedRows
      FROM sys.objects O
      INNER JOIN sys.schemas S ON S.schema_id = O.schema_id
      LEFT JOIN sys.partitions P
        ON P.object_id = O.object_id AND P.index_id IN (0, 1)
      WHERE O.type IN ('U', 'V') AND O.is_ms_shipped = 0
      GROUP BY S.name, O.name
    `),
  ]);

  const tableMap = new Map();
  for (const row of columnResult.recordset) {
    const key = `${String(row.SchemaName).toLowerCase()}.${String(row.ObjectName).toLowerCase()}`;
    if (!tableMap.has(key)) {
      tableMap.set(key, {
        schema: row.SchemaName,
        name: row.ObjectName,
        objectType: row.ObjectType,
        estimatedRows: 0,
        columns: [],
        indexes: [],
        relationships: [],
      });
    }
    tableMap.get(key).columns.push({
      ordinal: Number(row.Ordinal),
      name: row.ColumnName,
      dataType: row.DataType,
      formattedType: formatSqlType(row),
      isNullable: Boolean(row.IsNullable),
      isIdentity: Boolean(row.IsIdentity),
      isPrimaryKey: Boolean(row.IsPrimaryKey),
    });
  }

  const indexMap = new Map();
  for (const row of indexResult.recordset) {
    const tableKey = `${String(row.SchemaName).toLowerCase()}.${String(row.ObjectName).toLowerCase()}`;
    const table = tableMap.get(tableKey);
    if (!table) continue;
    const indexKey = `${tableKey}:${row.IndexName}`;
    if (!indexMap.has(indexKey)) {
      const index = {
        name: row.IndexName,
        type: row.IndexType,
        isUnique: Boolean(row.IsUnique),
        columns: [],
      };
      indexMap.set(indexKey, index);
      table.indexes.push(index);
    }
    indexMap.get(indexKey).columns.push(row.ColumnName);
  }

  for (const row of relationshipResult.recordset) {
    const relation = {
      name: row.RelationshipName,
      parentSchema: row.ParentSchema,
      parentTable: row.ParentTable,
      parentColumn: row.ParentColumn,
      referencedSchema: row.ReferencedSchema,
      referencedTable: row.ReferencedTable,
      referencedColumn: row.ReferencedColumn,
    };
    const parent = tableMap.get(
      `${String(row.ParentSchema).toLowerCase()}.${String(row.ParentTable).toLowerCase()}`,
    );
    const referenced = tableMap.get(
      `${String(row.ReferencedSchema).toLowerCase()}.${String(row.ReferencedTable).toLowerCase()}`,
    );
    if (parent) parent.relationships.push(relation);
    if (referenced && referenced !== parent) referenced.relationships.push(relation);
  }

  for (const row of countResult.recordset) {
    const table = tableMap.get(
      `${String(row.SchemaName).toLowerCase()}.${String(row.ObjectName).toLowerCase()}`,
    );
    if (table) table.estimatedRows = Number(row.EstimatedRows || 0);
  }

  const catalog = {
    tenantId,
    generatedAt: new Date().toISOString(),
    tables: [...tableMap.values()].sort((left, right) =>
      `${left.schema}.${left.name}`.localeCompare(`${right.schema}.${right.name}`),
    ),
  };
  catalog.text = buildCatalogText(catalog);
  const directory = await resolveTenantLogDirectory(tenantId);
  catalog.filePath = path.join(directory, "pos_database_catalog.txt");
  await fs.promises.writeFile(catalog.filePath, catalog.text, "utf8");
  const queryLogPath = path.join(directory, "ai_database_queries.log");
  const queryLogHandle = await fs.promises.open(queryLogPath, "a");
  await queryLogHandle.close();
  const conversationLogPath = path.join(directory, "ai_chat_conversations.log");
  const conversationLogHandle = await fs.promises.open(conversationLogPath, "a");
  await conversationLogHandle.close();

  console.log("[AI POS][Catalog] Metadata catalog ready", {
    tenantId,
    tableCount: catalog.tables.length,
    filePath: catalog.filePath,
    queryLogPath,
    conversationLogPath,
  });
  return catalog;
}

async function getDatabaseCatalog(tenantId, force = false) {
  const cached = catalogCache.get(tenantId);
  if (!force && cached && Date.now() - cached.loadedAt < CATALOG_TTL_MS) {
    return cached.catalog;
  }
  if (!force && catalogPromises.has(tenantId)) return catalogPromises.get(tenantId);

  const promise = loadCatalogFromDatabase(tenantId)
    .then((catalog) => {
      catalogCache.set(tenantId, { catalog, loadedAt: Date.now() });
      return catalog;
    })
    .finally(() => catalogPromises.delete(tenantId));
  catalogPromises.set(tenantId, promise);
  return promise;
}

function compactSchema(catalog, requestedTables = [], search = "", maxTables = 40) {
  const searchStopWords = new Set([
    "aaj", "aj", "today", "mujhe", "mein", "main", "ka", "ki", "ke", "ko",
    "se", "hain", "hai", "batao", "dikhao", "show", "tell", "what", "how",
    "many", "the", "table", "data", "total", "records", "record", "kitne",
    "please", "pls", "chahiye", "chahaiye",
  ]);
  const requested = new Set(
    (Array.isArray(requestedTables) ? requestedTables : [])
      .map((name) => stripIdentifier(name).toLowerCase())
      .filter(Boolean),
  );
  const searchTerms = String(search || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((term) => term.length >= 2 && !searchStopWords.has(term));
  let tables = catalog.tables.map((table) => {
    const fullName = `${table.schema}.${table.name}`.toLowerCase();
    if (requested.size) {
      return {
        table,
        score: requested.has(table.name.toLowerCase()) || requested.has(fullName) ? 1000 : 0,
      };
    }
    if (searchTerms.length) {
      const objectName = table.name.toLowerCase();
      const columns = table.columns.map((column) => column.name.toLowerCase());
      const score = searchTerms.reduce((sum, term) => {
        if (objectName === term || fullName === term) return sum + 500;
        if (objectName.includes(term)) return sum + 100;
        if (columns.some((column) => column === term)) return sum + 25;
        if (columns.some((column) => column.includes(term))) return sum + 5;
        return sum;
      }, 0);
      return { table, score };
    }
    return { table, score: 1 };
  });
  tables = tables
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        `${left.table.schema}.${left.table.name}`.localeCompare(
          `${right.table.schema}.${right.table.name}`,
        ),
    )
    .map((item) => item.table);
  const totalMatches = tables.length;
  const safeLimit = Math.max(1, Math.min(Number(maxTables) || 40, 40));
  tables = tables.slice(0, safeLimit);
  return tables
    .map((table) => {
      const columns = table.columns
        .map((column) => `${column.name}:${column.formattedType}${column.isPrimaryKey ? ":PK" : ""}`)
        .join(", ");
      const relationships = table.relationships
        .map(
          (item) =>
            `${item.parentSchema}.${item.parentTable}.${item.parentColumn}->${item.referencedSchema}.${item.referencedTable}.${item.referencedColumn}`,
        )
        .join("; ");
      return `${table.schema}.${table.name} [${columns}]${relationships ? ` RELATIONS ${relationships}` : ""}`;
    })
    .concat(
      totalMatches > tables.length
        ? [`... ${totalMatches - tables.length} additional matching objects omitted; narrow the search.`]
        : [],
    )
    .join("\n");
}

function stripIdentifier(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]/g, "$1")
    .replace(/\s+/g, "")
    .trim();
}

function validateReadOnlySql(sqlText, catalog, companyCode) {
  let statement = String(sqlText || "").trim();
  if (statement.endsWith(";")) statement = statement.slice(0, -1).trim();
  if (!statement) throw new Error("Empty SQL query");
  if (statement.length > 12000) throw new Error("SQL query is too long");
  if (!/^(select|with)\b/i.test(statement)) {
    throw new Error("Only SELECT queries are allowed");
  }
  if (/--|\/\*|\*\//.test(statement)) throw new Error("SQL comments are not allowed");
  if (statement.includes(";")) throw new Error("Multiple SQL statements are not allowed");

  const forbidden = [
    "insert", "update", "delete", "merge", "drop", "alter", "create",
    "truncate", "exec", "execute", "grant", "revoke", "deny", "backup",
    "restore", "dbcc", "waitfor", "openrowset", "opendatasource", "openquery",
    "bulk", "into", "use", "shutdown", "kill",
  ];
  const forbiddenMatch = forbidden.find((word) => new RegExp(`\\b${word}\\b`, "i").test(statement));
  if (forbiddenMatch) throw new Error(`Forbidden SQL keyword: ${forbiddenMatch}`);
  if (/\b(?:sys|information_schema)\s*\./i.test(statement)) {
    throw new Error("System catalog access is not allowed");
  }
  if (/\b(?:xp_|sp_)[a-z0-9_]+/i.test(statement)) {
    throw new Error("Stored procedure access is not allowed");
  }

  const cteNames = new Set();
  const cteRegex = /(?:\bwith\b|,)\s*(\[[^\]]+\]|[a-z_][\w$#]*)\s+as\s*\(/gi;
  for (const match of statement.matchAll(cteRegex)) {
    cteNames.add(stripIdentifier(match[1]).toLowerCase());
  }

  const referencedTables = new Set();
  const sourceRegex = /\b(?:from|join)\s+((?:\[[^\]]+\]|[a-z_][\w$#]*)(?:\s*\.\s*(?:\[[^\]]+\]|[a-z_][\w$#]*)){0,2})/gi;
  for (const match of statement.matchAll(sourceRegex)) {
    const identifier = stripIdentifier(match[1]);
    const parts = identifier.split(".");
    if (parts.length > 2) throw new Error("Cross-database queries are not allowed");
    const objectName = parts[parts.length - 1].toLowerCase();
    if (cteNames.has(objectName)) continue;
    const schemaName = parts.length === 2 ? parts[0].toLowerCase() : "";
    const matches = catalog.tables.filter(
      (table) =>
        table.name.toLowerCase() === objectName &&
        (!schemaName || table.schema.toLowerCase() === schemaName),
    );
    if (matches.length === 0) {
      throw new Error(`Table/view is not present in the selected database: ${identifier}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous object name; use schema-qualified name: ${identifier}`);
    }
    referencedTables.add(`${matches[0].schema}.${matches[0].name}`);
  }
  if (referencedTables.size === 0) {
    throw new Error("Query must use a user table/view from the selected database");
  }

  const variables = [...statement.matchAll(/@[a-z_][\w$#]*/gi)].map((match) => match[0].toLowerCase());
  if (variables.some((variable) => variable !== "@companycode")) {
    throw new Error("Only the @companyCode SQL parameter is available");
  }
  const companyScoped = [...referencedTables].some((tableName) => {
    const table = catalog.tables.find(
      (item) => `${item.schema}.${item.name}`.toLowerCase() === tableName.toLowerCase(),
    );
    return table?.columns.some((column) => column.name.toLowerCase() === "companycode");
  });
  if (companyScoped && companyCode) {
    if (!/@companycode\b/i.test(statement) || !/\bcompanycode\b/i.test(statement)) {
      throw new Error("Query must filter CompanyCode using @companyCode");
    }
  }

  return { statement, referencedTables: [...referencedTables] };
}

function serializeDatabaseValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (typeof value === "bigint") return value.toString();
  return value;
}

async function appendAuditLog(tenantId, entry) {
  const directory = await resolveTenantLogDirectory(tenantId);
  const filePath = path.join(directory, "ai_database_queries.log");
  const lines = [
    "-".repeat(88),
    `Timestamp: ${entry.timestamp}`,
    `Tenant: ${tenantId}`,
    `Source: LIVE_MSSQL`,
    `Database: ${entry.database || "unknown"}`,
    `Server: ${entry.server || "unknown"}`,
    `User: ${entry.userId || "unknown"}`,
    `Company: ${entry.companyCode || "unknown"}`,
    `Question: ${String(entry.question || "").replace(/\s+/g, " ")}`,
    `Purpose: ${String(entry.purpose || "").replace(/\s+/g, " ")}`,
    `Tables: ${(entry.tables || []).join(", ") || "none"}`,
    `SQL: ${String(entry.sql || "").replace(/\s+/g, " ")}`,
    `Status: ${entry.status}`,
    `Rows: ${entry.rowCount ?? 0}`,
    `ResultColumns: ${(entry.resultColumns || []).join(", ") || "none"}`,
    entry.resultPreview ? `ResultPreview: ${entry.resultPreview}` : "",
    `DurationMs: ${entry.durationMs ?? 0}`,
    entry.error ? `Error: ${String(entry.error).replace(/\s+/g, " ")}` : "",
    "",
  ].filter(Boolean);
  await fs.promises.appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
  console.log("[AI POS][Audit] Query log appended", { tenantId, filePath });
  return filePath;
}

async function appendConversationLog(tenantId, entry) {
  const directory = await resolveTenantLogDirectory(tenantId);
  const filePath = path.join(directory, "ai_chat_conversations.log");
  const block = [
    "=".repeat(88),
    `Timestamp: ${entry.timestamp}`,
    `User: ${entry.userId || "unknown"}`,
    `Company: ${entry.companyCode || "unknown"}`,
    `Provider: ${entry.provider || "unknown"}`,
    `Model: ${entry.model || "unknown"}`,
    `Database tool calls: ${entry.toolCallsUsed || 0}`,
    "",
    "QUESTION",
    String(entry.question || ""),
    "",
    "ANSWER",
    String(entry.answer || ""),
    "",
  ].join("\n");
  await fs.promises.appendFile(filePath, `${block}\n`, "utf8");
  console.log("[AI POS][Audit] Conversation log appended", { tenantId, filePath });
  return filePath;
}

async function executeReadOnlyQuery({
  tenantId,
  userId,
  companyCode,
  question,
  purpose,
  sqlText,
}) {
  const catalog = await getDatabaseCatalog(tenantId);
  const validated = validateReadOnlySql(sqlText, catalog, companyCode);
  const maxRows = Math.max(
    1,
    Math.min(Number(process.env.AI_SQL_MAX_ROWS || DEFAULT_MAX_ROWS), 1000),
  );
  const timeoutMs = Math.max(
    1000,
    Math.min(Number(process.env.AI_SQL_TIMEOUT_MS || 30000), 120000),
  );
  const startedAt = Date.now();
  const tenant = getTenantById(tenantId);
  const databaseIdentity = {
    source: "LIVE_MSSQL",
    database: tenant?.config?.database || "unknown",
    server: tenant?.config?.server || "unknown",
  };

  console.log("[AI POS][SQL] Executing read-only query", {
    ...databaseIdentity,
    tenantId,
    userId,
    companyCode,
    purpose,
    tables: validated.referencedTables,
    maxRows,
    timeoutMs,
    sql: validated.statement,
  });

  try {
    const db = await getPoolForTenant(tenantId);
    const request = db.request();
    request.timeout = timeoutMs;
    request.input("companyCode", sql.VarChar(100), companyCode || "");
    const result = await request.query(`
      SET NOCOUNT ON;
      SET ROWCOUNT ${maxRows};
      BEGIN TRY
        ${validated.statement};
        SET ROWCOUNT 0;
      END TRY
      BEGIN CATCH
        SET ROWCOUNT 0;
        THROW;
      END CATCH
    `);
    const rows = (result.recordset || []).map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, serializeDatabaseValue(value)]),
      ),
    );
    const durationMs = Date.now() - startedAt;
    const resultColumns = rows.length ? Object.keys(rows[0]) : [];
    const resultPreview = JSON.stringify(rows.slice(0, 3)).slice(0, 4000);
    await appendAuditLog(tenantId, {
      timestamp: new Date().toISOString(),
      userId,
      companyCode,
      database: databaseIdentity.database,
      server: databaseIdentity.server,
      question,
      purpose,
      tables: validated.referencedTables,
      sql: validated.statement,
      status: "SUCCESS",
      rowCount: rows.length,
      resultColumns,
      resultPreview,
      durationMs,
    });
    console.log("[AI POS][SQL] Query completed", {
      tenantId,
      rows: rows.length,
      durationMs,
    });
    return {
      rows,
      rowCount: rows.length,
      maxRows,
      limited: rows.length >= maxRows,
      durationMs,
      tables: validated.referencedTables,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await appendAuditLog(tenantId, {
      timestamp: new Date().toISOString(),
      userId,
      companyCode,
      database: databaseIdentity.database,
      server: databaseIdentity.server,
      question,
      purpose,
      tables: validated.referencedTables,
      sql: validated.statement,
      status: "ERROR",
      rowCount: 0,
      durationMs,
      error: error.message,
    }).catch((logError) => console.error("[AI POS][Audit] Failed to log error", logError));
    console.error("[AI POS][SQL] Query failed", {
      tenantId,
      durationMs,
      message: error.message,
    });
    throw error;
  }
}

async function readQueryLog(tenantId) {
  const directory = await resolveTenantLogDirectory(tenantId);
  const filePath = path.join(directory, "ai_database_queries.log");
  try {
    const text = await fs.promises.readFile(filePath, "utf8");
    return text.length > 250000 ? text.slice(-250000) : text;
  } catch (error) {
    if (error.code === "ENOENT") return "No AI database queries have been logged yet.\n";
    throw error;
  }
}

async function readConversationLog(tenantId) {
  const directory = await resolveTenantLogDirectory(tenantId);
  const filePath = path.join(directory, "ai_chat_conversations.log");
  try {
    const text = await fs.promises.readFile(filePath, "utf8");
    return text.length > 250000 ? text.slice(-250000) : text;
  } catch (error) {
    if (error.code === "ENOENT") return "No AI conversations have been logged yet.\n";
    throw error;
  }
}

module.exports = {
  appendConversationLog,
  compactSchema,
  executeReadOnlyQuery,
  getDatabaseCatalog,
  readConversationLog,
  readQueryLog,
  validateReadOnlySql,
};

