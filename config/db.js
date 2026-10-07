const sql = require("mssql");
const { getTenantById } = require("./tenants");

const pools = new Map();
const TRANSIENT_CODES = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ESOCKET",
  "ETIMEOUT",
]);

function collectErrorCodes(error) {
  const codes = [];
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current.code) codes.push(String(current.code).toUpperCase());
    current = current.originalError || current.cause;
  }
  return codes;
}

function isTransientDatabaseError(error) {
  const codes = collectErrorCodes(error);
  if (codes.some((code) => TRANSIENT_CODES.has(code))) return true;
  const message = String(error?.message || "").toUpperCase();
  return [...TRANSIENT_CODES].some((code) => message.includes(code));
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectTenantWithRetry(tenant, maxAttempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await new sql.ConnectionPool(tenant.config).connect();
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt === maxAttempts) throw error;
      const delay = 750 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      console.warn(
        `[DB] Temporary connection issue [${tenant.id}] (${collectErrorCodes(error).join("/") || "UNKNOWN"}); retry ${attempt}/${maxAttempts - 1} in ${delay}ms`,
      );
      await wait(delay);
    }
  }
  throw lastError;
}

async function getPoolForTenant(tenantId) {
  const tenant = getTenantById(tenantId);
  if (!tenant) {
    const error = new Error("Invalid tenant");
    error.code = "INVALID_TENANT";
    throw error;
  }

  const existing = pools.get(tenantId);
  if (existing) return existing;

  let connectionPromise;
  connectionPromise = connectTenantWithRetry(tenant)
    .then((pool) => {
      console.log(`✅ MSSQL Connected [${tenant.id}]`);
      pool.on("error", (err) => {
        console.error(`❌ MSSQL Pool Error [${tenant.id}]:`, err.message);
        if (pools.get(tenantId) === connectionPromise) pools.delete(tenantId);
        void pool.close().catch(() => undefined);
      });
      return pool;
    })
    .catch((err) => {
      pools.delete(tenantId);
      console.error(`❌ DB Error [${tenant.id}]:`, err.message);
      throw err;
    });

  pools.set(tenantId, connectionPromise);
  return connectionPromise;
}

function sendDatabaseError(res, error, message = "Database request could not be completed") {
  const retryable = isTransientDatabaseError(error);
  if (retryable) res.set("Retry-After", "3");
  return res.status(retryable ? 503 : 500).json({
    success: false,
    code: retryable ? "DATABASE_TEMPORARILY_UNAVAILABLE" : "DATABASE_REQUEST_FAILED",
    retryable,
    message: retryable
      ? "Company database is temporarily unavailable. Please retry shortly."
      : message,
  });
}

async function testTenantConnection(tenantId) {
  const pool = await getPoolForTenant(tenantId);
  await pool.request().query("SELECT 1 AS ok");
  return true;
}

async function closeAllPools() {
  const currentPools = Array.from(pools.values());
  pools.clear();
  await Promise.allSettled(
    currentPools.map(async (poolPromise) => {
      const pool = await poolPromise;
      if (pool?.connected) await pool.close();
    }),
  );
}

module.exports = {
  sql,
  getPoolForTenant,
  testTenantConnection,
  closeAllPools,
  isTransientDatabaseError,
  sendDatabaseError,
};
