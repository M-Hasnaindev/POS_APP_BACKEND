const crypto = require("crypto");
require("dotenv").config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

function optional(name, fallback = "") {
  const value = process.env[name];
  return value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : String(value).trim();
}

function buildTenant(index) {
  const prefix = `DB_${index}`;
  const database = optional(`${prefix}_DATABASE`, optional(`DB_DATABASE_${index}`));
  const key = optional(`${prefix}_KEY`, optional(`DB_KEY_${index}`));

  if (!database || !key) return null;

  return {
    id: `tenant_${index}`,
    key,
    label: optional(`${prefix}_LABEL`, `Company ${index}`),
    config: {
      user: optional(`${prefix}_USER`, required("DB_USER")),
      password: optional(`${prefix}_PASSWORD`, required("DB_PASSWORD")),
      server: optional(`${prefix}_SERVER`, required("DB_SERVER")),
      database,
      port: Number(optional(`${prefix}_PORT`, required("DB_PORT"))),
      options: {
        encrypt: optional(`${prefix}_ENCRYPT`, "false").toLowerCase() === "true",
        trustServerCertificate:
          optional(`${prefix}_TRUST_SERVER_CERTIFICATE`, "true").toLowerCase() === "true",
      },
      pool: {
        max: Number(optional(`${prefix}_POOL_MAX`, "10")),
        min: 0,
        idleTimeoutMillis: 30000,
      },
      requestTimeout: Number(optional(`${prefix}_REQUEST_TIMEOUT`, "300000")),
      connectionTimeout: Number(optional(`${prefix}_CONNECTION_TIMEOUT`, "30000")),
    },
  };
}

const tenants = [buildTenant(1), buildTenant(2)].filter(Boolean);

if (tenants.length === 0) {
  throw new Error("No tenant databases configured. Configure DB_1_DATABASE/DB_1_KEY (and DB_2_* if needed).");
}

const duplicateKey = tenants.find((tenant, index) =>
  tenants.some((other, otherIndex) => otherIndex !== index && other.key === tenant.key),
);
if (duplicateKey) {
  throw new Error("Tenant keys must be unique.");
}

function constantTimeEquals(a, b) {
  const aHash = crypto.createHash("sha256").update(String(a)).digest();
  const bHash = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

function resolveTenantByKey(key) {
  if (!key) return null;
  return tenants.find((tenant) => constantTimeEquals(tenant.key, key)) || null;
}

function getTenantById(tenantId) {
  return tenants.find((tenant) => tenant.id === tenantId) || null;
}

function getPublicTenant(tenant) {
  if (!tenant) return null;
  return { id: tenant.id, label: tenant.label };
}

module.exports = {
  tenants,
  resolveTenantByKey,
  getTenantById,
  getPublicTenant,
};
