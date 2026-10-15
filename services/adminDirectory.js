const { getPoolForTenant, sql } = require("../config/db");
const { tenants, getTenantById } = require("../config/tenants");
const { fail } = require("./adminStore");
const masked = (value) => (value ? "••••••••" : "");
const tenantSummary = (t) => ({ id: t.id, label: t.label, key: masked(t.key) });
async function detail(id) {
  const tenant = getTenantById(id);
  if (!tenant) throw fail("Tenant not found.", 404);
  const db = await getPoolForTenant(id);
  const users = (
    await db
      .request()
      .query(
        "SELECT CompanyCode,UserID,UserName,ShortName,UserType,EmailId,MobileNo FROM dbo.Security",
      )
  ).recordset.map((r) => ({
    companyCode: String(r.CompanyCode ?? "").trim(),
    userId: String(r.UserID).trim(),
    displayName: String(r.UserName || r.ShortName || r.UserID),
    userType: r.UserType,
    email: r.EmailId || "",
    mobile: r.MobileNo || "",
  }));
  const map = new Map();
  for (const u of users) {
    if (!map.has(u.companyCode))
      map.set(u.companyCode, {
        companyCode: u.companyCode,
        name: u.companyCode || "Default company",
        userCount: 0,
      });
    map.get(u.companyCode).userCount++;
  }
  const columns = (
    await db
      .request()
      .query(
        "SELECT TABLE_NAME,COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME IN ('Companies','Defaults','AccountInfo')",
      )
  ).recordset;
  const available = (table) =>
    columns.filter((c) => c.TABLE_NAME === table).map((c) => c.COLUMN_NAME);
  const pick = (names, candidates) => candidates.find((n) => names.includes(n));
  const companyCols = available("Companies"),
    code = pick(companyCols, ["CompanyCode", "CompanyID", "CompanyId", "Code"]),
    name = pick(companyCols, ["CompanyName", "Name", "Company", "Description"]);
  if (code) {
    const rows = (
      await db
        .request()
        .query(
          `SELECT [${code}] AS code,${name ? "[" + name + "]" : "[" + code + "]"} AS name FROM dbo.Companies`,
        )
    ).recordset;
    for (const r of rows) {
      const k = String(r.code ?? "").trim();
      map.set(k, {
        companyCode: k,
        name: String(r.name || k),
        userCount: map.get(k)?.userCount || 0,
      });
    }
  }
  const defaults = available("Defaults");
  if (defaults.includes("CompanyID")) {
    for (const r of (
      await db.request().query("SELECT DISTINCT CompanyID FROM dbo.Defaults")
    ).recordset) {
      const k = String(r.CompanyID ?? "").trim();
      if (!map.has(k)) map.set(k, { companyCode: k, name: k, userCount: 0 });
    }
  }
  if (map.size === 1 && available("AccountInfo").includes("AccountName")) {
    const r = (
      await db.request().query("SELECT TOP 1 AccountName FROM dbo.AccountInfo")
    ).recordset[0];
    if (r?.AccountName) map.values().next().value.name = String(r.AccountName);
  }
  return { tenant: tenantSummary(tenant), companies: [...map.values()], users };
}
function environment() {
  return Object.keys(process.env)
    .filter((name) =>
      /^(DB_(USER|PASSWORD|SERVER|PORT|(?:DATABASE|KEY)_\d+|\d+_(DATABASE|KEY|LABEL|KEY_EXPIRES_AT|USER|PASSWORD|SERVER|PORT|ENCRYPT|TRUST_SERVER_CERTIFICATE|POOL_MAX|REQUEST_TIMEOUT|CONNECTION_TIMEOUT))|JWT_SECRET|JWT_EXPIRES_IN|TENANT_TOKEN_EXPIRES_IN|CRON_SECRET|RESOURCE_(SQL_TIMEOUT_MS|SYNC_DATABASE|SYNC_TENANT)|OLLAMA_(API_KEY|AUTH_TOKEN|BASE_URL|FALLBACK_MODELS|MODEL|MODEL_CANDIDATES|TIMEOUT_MS)|FIREBASE_(CLIENT_EMAIL|PRIVATE_KEY|PROJECT_ID|SERVICE_ACCOUNT_JSON)|FCM_SERVICE_ACCOUNT_FILE|GOOGLE_APPLICATION_CREDENTIALS)$/.test(
        name,
      ),
    )
    .sort();
}
async function validateScope(row) {
  const t = getTenantById(row.tenantId);
  if (!t) throw fail("Invalid tenant.");
  if (row.scope === "tenant") return;
  const d = await detail(row.tenantId);
  if (
    row.scope === "company" &&
    !d.companies.some((c) => c.companyCode === row.companyCode)
  )
    throw fail("Company not found in tenant.");
  if (
    row.scope === "user" &&
    !d.users.some(
      (u) => u.companyCode === row.companyCode && u.userId === row.userId,
    )
  )
    throw fail("User not found in tenant/company.");
}
module.exports = {
  detail,
  environment,
  validateScope,
  tenantSummary,
  masked,
  tenants,
  getTenantById,
};
