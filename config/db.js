const sql = require("mssql");
const { getTenantById, tenants } = require("./tenants");

const pools = new Map();

async function getPoolForTenant(tenantId) {
  const tenant = getTenantById(tenantId);
  if (!tenant) {
    const error = new Error("Invalid tenant");
    error.code = "INVALID_TENANT";
    throw error;
  }

  const existing = pools.get(tenantId);
  if (existing) return existing;

  const connectionPromise = new sql.ConnectionPool(tenant.config)
    .connect()
    .then((pool) => {
      console.log(`✅ MSSQL Connected [${tenant.id}]`);
      pool.on("error", (err) => {
        console.error(`❌ MSSQL Pool Error [${tenant.id}]:`, err.message);
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

async function testTenantConnection(tenantId) {
  const pool = await getPoolForTenant(tenantId);
  await pool.request().query("SELECT 1 AS ok");
  return true;
}

async function getDefaultPool() {
  const configuredTenantId = String(process.env.VERSION_DB_TENANT_ID || "").trim();
  const tenantId = configuredTenantId || tenants[0]?.id;
  if (!tenantId) throw new Error("No default database is configured");
  return getPoolForTenant(tenantId);
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

module.exports = { sql, getPoolForTenant, getDefaultPool, testTenantConnection, closeAllPools };
