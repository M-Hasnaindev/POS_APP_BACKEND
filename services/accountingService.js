const { sql } = require("../config/db");

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 3;
const DEFAULT_PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 5000;
const snapshotCache = new Map();

const ACC_PROC_SQL = `EXEC AccProc
  '',
  @fromDate,
  @toDate,
  'L',
  'AL',
  @userId,
  '',
  'ALL',
  '0',
  'Y',
  'Y',
  '00000000000000',
  'zzzzzzzzzzzzzz',
  'Y',
  @companyCode,
  'N',
  '',
  'B',
  'V'`;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function normalizeDateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`;
  }

  const text = String(value || "").trim();
  const isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const localMatch = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (localMatch) {
    return `${localMatch[3]}-${pad2(localMatch[2])}-${pad2(localMatch[1])}`;
  }

  return null;
}

function pakistanToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizePagination(query = {}) {
  const page = Number.parseInt(String(query.page || "1"), 10);
  const requestedSize = Number.parseInt(String(query.pageSize || DEFAULT_PAGE_SIZE), 10);
  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize:
      Number.isFinite(requestedSize) && requestedSize > 0
        ? Math.min(requestedSize, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE,
  };
}

async function resolveAuthenticatedCompanyCode(pool, userId, tokenCompanyCode, requestedCompanyCode) {
  const companyFromToken = String(tokenCompanyCode || "").trim();
  if (companyFromToken) return companyFromToken;

  const requested = String(requestedCompanyCode || "").trim();

  const securityRequest = pool
    .request()
    .input("userId", sql.VarChar(100), userId);
  let securityQuery = `
      SELECT DISTINCT LTRIM(RTRIM(CompanyCode)) AS CompanyCode
      FROM Security
      WHERE LTRIM(RTRIM(UserID)) = LTRIM(RTRIM(@userId))
        AND NULLIF(LTRIM(RTRIM(CompanyCode)), '') IS NOT NULL
    `;
  if (requested) {
    securityRequest.input("requestedCompanyCode", sql.VarChar(50), requested);
    securityQuery += " AND LTRIM(RTRIM(CompanyCode)) = @requestedCompanyCode";
  }
  const result = await securityRequest.query(securityQuery);
  const companyCodes = Array.from(
    new Set(
      (result.recordset || [])
        .map((row) => String(row.CompanyCode || "").trim())
        .filter(Boolean),
    ),
  );

  if (companyCodes.length === 1) return companyCodes[0];

  // Some legacy/admin Security rows intentionally have no CompanyCode. Stock
  // sync already handles this case through the tenant's BranchFile. Accounting
  // must resolve the same authenticated tenant scope instead of rejecting the
  // valid fresh login after Sales and Inventory have completed.
  const tenantRequest = pool.request();
  let tenantQuery = `
    SELECT DISTINCT CompanyCode
    FROM (
      SELECT LTRIM(RTRIM(CompanyCode)) AS CompanyCode
      FROM BranchFile
      WHERE NULLIF(LTRIM(RTRIM(CompanyCode)), '') IS NOT NULL
      UNION
      SELECT LTRIM(RTRIM(CompanyID)) AS CompanyCode
      FROM Defaults
      WHERE NULLIF(LTRIM(RTRIM(CompanyID)), '') IS NOT NULL
    ) AS TenantCompanies
    WHERE 1 = 1`;
  if (requested) {
    tenantRequest.input("requestedCompanyCode", sql.VarChar(50), requested);
    tenantQuery += " AND CompanyCode = @requestedCompanyCode";
  }
  const tenantResult = await tenantRequest.query(tenantQuery);
  const tenantCompanyCodes = Array.from(
    new Set(
      (tenantResult.recordset || [])
        .map((row) => String(row.CompanyCode || "").trim())
        .filter(Boolean),
    ),
  );
  if (tenantCompanyCodes.length === 1) return tenantCompanyCodes[0];

  const error = new Error(
    companyCodes.length > 1 || tenantCompanyCodes.length > 1
      ? "Your saved login cannot identify one company. Please sign in again."
      : "Company access was not found for this user. Please sign in again.",
  );
  error.statusCode = 401;
  throw error;
}

async function resolveCompanyStartDate(pool, companyCode) {
  const result = await pool
    .request()
    .input("companyId", sql.VarChar(50), companyCode)
    .query("SELECT TOP 1 FromDate FROM Defaults WHERE CompanyID = @companyId");
  return normalizeDateOnly(result.recordset?.[0]?.FromDate);
}

function trimCache() {
  const now = Date.now();
  for (const [key, entry] of snapshotCache.entries()) {
    if (entry.expiresAt <= now) snapshotCache.delete(key);
  }
  while (snapshotCache.size > MAX_CACHE_ENTRIES) {
    snapshotCache.delete(snapshotCache.keys().next().value);
  }
}

async function executeAccountingSnapshot(pool, { fromDate, toDate, userId, companyCode }) {
  const request = pool.request();
  request.timeout = 300000;
  const result = await request
    .input("fromDate", sql.VarChar(10), fromDate)
    .input("toDate", sql.VarChar(10), toDate)
    .input("userId", sql.VarChar(100), userId)
    .input("companyCode", sql.VarChar(50), companyCode)
    .query(ACC_PROC_SQL);
  return Array.isArray(result.recordset) ? result.recordset : [];
}

async function loadAccountingSnapshot({ pool, tenantId, userId, companyCode }) {
  const fromDate = await resolveCompanyStartDate(pool, companyCode);
  if (!fromDate) {
    const error = new Error("Company start date was not found in Defaults");
    error.statusCode = 422;
    throw error;
  }

  const toDate = pakistanToday();
  const cacheKey = [tenantId, companyCode, userId, fromDate, toDate].join("|");
  trimCache();

  const cached = snapshotCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { rows: await cached.promise, fromDate, toDate };
  }

  const promise = executeAccountingSnapshot(pool, {
    fromDate,
    toDate,
    userId,
    companyCode,
  });
  snapshotCache.set(cacheKey, { promise, expiresAt: Date.now() + CACHE_TTL_MS });

  try {
    const rows = await promise;
    trimCache();
    return { rows, fromDate, toDate };
  } catch (error) {
    snapshotCache.delete(cacheKey);
    throw error;
  }
}

function clearAccountingSnapshotCache() {
  snapshotCache.clear();
}

module.exports = {
  ACC_PROC_SQL,
  clearAccountingSnapshotCache,
  loadAccountingSnapshot,
  normalizeDateOnly,
  normalizePagination,
  pakistanToday,
  resolveAuthenticatedCompanyCode,
};
