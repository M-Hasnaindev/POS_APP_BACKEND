const { sql, getPoolForTenant } = require("../config/db");
const { getDatabaseCatalog } = require("./aiDatabaseService");
const trainingKnowledge = require("../ai/trainingKnowledge.generated.json");

const RESOURCE_VERSION = "2026-09-07-v1";
const MAX_PAGE_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 250;
const SQL_CLOSE_BRACKET_ESCAPE = "]]";
const REQUIRED_TABLES = Object.freeze(Object.keys(trainingKnowledge.tables || {}));
const REQUIRED_TABLE_LOOKUP = new Map(
  REQUIRED_TABLES.map((name) => [name.toLowerCase(), name]),
);

function identifier(value) {
  const escaped = String(value).replaceAll("]", SQL_CLOSE_BRACKET_ESCAPE);
  return `[${escaped}]`;
}

function normalizeTableName(value) {
  const requested = String(value || "").trim().toLowerCase();
  const canonical = REQUIRED_TABLE_LOOKUP.get(requested);
  if (!canonical) {
    const error = new Error("This table is not part of the approved AI resource pack");
    error.status = 404;
    throw error;
  }
  return canonical;
}

function findCatalogTable(catalog, canonicalName) {
  return catalog.tables.find(
    (table) => String(table.name).toLowerCase() === canonicalName.toLowerCase(),
  );
}

function serializeTable(table) {
  return {
    schema: table.schema,
    name: table.name,
    objectType: table.objectType,
    estimatedRows: Number(table.estimatedRows || 0),
    columns: table.columns.map((column) => ({
      ordinal: Number(column.ordinal),
      name: column.name,
      dataType: column.dataType,
      formattedType: column.formattedType,
      isNullable: Boolean(column.isNullable),
      isIdentity: Boolean(column.isIdentity),
      isPrimaryKey: Boolean(column.isPrimaryKey),
    })),
  };
}

function documentedEmptyTable(name) {
  const documented = trainingKnowledge.tables?.[name];
  return {
    schema: "dbo",
    name,
    objectType: "DOCUMENTED_EMPTY",
    estimatedRows: 0,
    columns: (documented?.fields || []).map((field, index) => ({
      ordinal: index + 1,
      name: field.name,
      dataType: "nvarchar",
      formattedType: "nvarchar(MAX)",
      isNullable: true,
      isIdentity: false,
      isPrimaryKey: false,
    })),
  };
}

async function listAiResources(tenantId, force = false) {
  const catalog = await getDatabaseCatalog(tenantId, force);
  const resources = [];
  const missing = [];

  for (const name of REQUIRED_TABLES) {
    const table = findCatalogTable(catalog, name);
    if (!table) {
      missing.push(name);
      resources.push(documentedEmptyTable(name));
      continue;
    }
    resources.push(serializeTable(table));
  }

  return {
    version: RESOURCE_VERSION,
    requiredCount: REQUIRED_TABLES.length,
    resources,
    missing,
  };
}

function chooseOrderColumns(table) {
  const primary = table.columns.filter((column) => column.isPrimaryKey);
  if (primary.length) return primary;

  const nonComparable = new Set([
    "text",
    "ntext",
    "image",
    "xml",
    "geography",
    "geometry",
    "hierarchyid",
  ]);
  return table.columns
    .filter((column) => !nonComparable.has(String(column.dataType || "").toLowerCase()))
    .slice(0, 4);
}

async function readAiResourcePage({ tenantId, tableName, page, pageSize }) {
  const canonicalName = normalizeTableName(tableName);
  const catalog = await getDatabaseCatalog(tenantId, false);
  const table = findCatalogTable(catalog, canonicalName);
  if (!table) {
    return {
      version: RESOURCE_VERSION,
      table: documentedEmptyTable(canonicalName),
      page: 1,
      pageSize: Math.max(50, Math.min(Number.parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)),
      hasMore: false,
      rows: [],
    };
  }

  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.max(
    50,
    Math.min(Number.parseInt(pageSize, 10) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
  );
  const offset = (safePage - 1) * safePageSize;
  const take = safePageSize + 1;
  const orderColumns = chooseOrderColumns(table);
  const orderBy = orderColumns.length
    ? orderColumns.map((column) => identifier(column.name)).join(", ")
    : "(SELECT NULL)";
  const columnSql = table.columns.map((column) => identifier(column.name)).join(", ");

  const pool = await getPoolForTenant(tenantId);
  const request = pool.request();
  request.timeout = Math.max(30000, Math.min(Number(process.env.AI_RESOURCE_SQL_TIMEOUT_MS || 90000), 180000));
  request.input("offset", sql.Int, offset);
  request.input("take", sql.Int, take);
  const result = await request.query(`
    SELECT ${columnSql}
    FROM ${identifier(table.schema)}.${identifier(table.name)}
    ORDER BY ${orderBy}
    OFFSET @offset ROWS FETCH NEXT @take ROWS ONLY
  `);

  const rows = result.recordset || [];
  const hasMore = rows.length > safePageSize;
  return {
    version: RESOURCE_VERSION,
    table: serializeTable(table),
    page: safePage,
    pageSize: safePageSize,
    hasMore,
    rows: hasMore ? rows.slice(0, safePageSize) : rows,
  };
}

module.exports = {
  RESOURCE_VERSION,
  REQUIRED_TABLES,
  listAiResources,
  readAiResourcePage,
};
