const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const projectRoot = path.resolve(__dirname, "..");
const envPath = path.join(projectRoot, ".env");
const keyDeliveryPath = path.join(projectRoot, "TENANT_KEYS.txt");
const rawEnv = fs.readFileSync(envPath, "utf8");
const parsedEnv = dotenv.parse(rawEnv);

for (const [name, value] of Object.entries(parsedEnv)) {
  if (process.env[name] === undefined) process.env[name] = value;
}

const { tenants } = require("../config/tenants");
const { getPoolForTenant, closeAllPools } = require("../config/db");

function companySlug(value) {
  const slug = String(value || "COMPANY")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toUpperCase();
  return slug || "COMPANY";
}

function encryptedYear(year, tenantId, companyName, purpose) {
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(`cherrys-tenant-key:v1:${tenantId}:${companyName}:${purpose}:${year}`)
    .digest("base64url")
    .slice(0, 10)
    .toUpperCase();
}

function upsertEnv(source, name, value) {
  const line = `${name}=${value}`;
  const matcher = new RegExp(`^${name}=.*$`, "m");
  return matcher.test(source)
    ? source.replace(matcher, line)
    : `${source.replace(/\s*$/, "")}\n${line}\n`;
}

async function updateVercel(values) {
  const project = JSON.parse(fs.readFileSync(path.join(projectRoot, ".vercel", "project.json"), "utf8"));
  const authPath = path.join(process.env.APPDATA || "", "com.vercel.cli", "Data", "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  const apiRoot = "https://api.vercel.com";
  const scope = `teamId=${encodeURIComponent(project.orgId)}`;
  const headers = { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" };
  const request = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Vercel environment update failed (${response.status}): ${body?.error?.message || "unknown error"}`);
    return body;
  };
  const list = async () => (await request(`${apiRoot}/v10/projects/${project.projectId}/env?${scope}`)).envs || [];
  const names = Object.keys(values);

  // Delete by unique record ID because legacy projects can contain duplicate
  // Preview variables that the name-based CLI cannot safely disambiguate.
  const existing = (await list()).filter((item) => names.includes(item.key));
  for (const item of existing) {
    await request(`${apiRoot}/v9/projects/${project.projectId}/env/${item.id}?${scope}`, { method: "DELETE" });
  }
  for (const key of names) {
    for (const target of ["production", "preview"]) {
      await request(`${apiRoot}/v10/projects/${project.projectId}/env?${scope}`, {
        method: "POST",
        body: JSON.stringify({ key, value: values[key], type: "sensitive", target: [target] }),
      });
    }
  }

  const normalized = (await list()).filter((item) => names.includes(item.key));
  const invalid = names.filter((key) => {
    const matches = normalized.filter((item) => item.key === key);
    return matches.length !== 2
      || !matches.some((item) => item.target?.includes("production"))
      || !matches.some((item) => item.target?.includes("preview"));
  });
  if (invalid.length) throw new Error(`Vercel environment verification failed: ${invalid.join(", ")}`);
}

async function main() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required to encrypt year tokens");

  const createdYear = new Date().getUTCFullYear();
  const expiryYear = createdYear + 2;
  const expiresAt = `${expiryYear}-12-31T23:59:59.999Z`;
  const rotations = [];
  let nextEnv = rawEnv;

  for (const tenant of tenants) {
    const index = Number(tenant.id.replace("tenant_", ""));
    const db = await getPoolForTenant(tenant.id);
    const result = await db.request().query(`
      SELECT TOP 1 AccountName
      FROM AccountInfo
      WHERE NULLIF(LTRIM(RTRIM(AccountName)), '') IS NOT NULL
    `);
    const companyName = String(result.recordset[0]?.AccountName || tenant.label).trim();
    const slug = companySlug(companyName);
    const createdToken = encryptedYear(createdYear, tenant.id, companyName, "created");
    const expiryToken = encryptedYear(expiryYear, tenant.id, companyName, "expires");
    const key = `CT-${createdToken}-${slug}-${expiryToken}`;

    const values = {
      [`DB_${index}_KEY`]: key,
      [`DB_${index}_KEY_EXPIRES_AT`]: expiresAt,
      [`DB_${index}_LABEL`]: companyName,
    };
    for (const [name, value] of Object.entries(values)) nextEnv = upsertEnv(nextEnv, name, value);
    rotations.push({ index, tenantId: tenant.id, companyName, key, expiresAt, values });
  }

  fs.writeFileSync(envPath, nextEnv, "utf8");
  fs.writeFileSync(
    keyDeliveryPath,
    [
      "CherryTech company keys — confidential",
      `Created year: ${createdYear}`,
      `Expiry: ${expiresAt}`,
      "",
      ...rotations.flatMap((item) => [
        `${item.companyName}`,
        `Key: ${item.key}`,
        `Expires: ${item.expiresAt}`,
        "",
      ]),
    ].join("\n"),
    "utf8",
  );

  if (process.argv.includes("--vercel")) {
    await updateVercel(Object.assign({}, ...rotations.map((item) => item.values)));
  }

  console.log(JSON.stringify({
    rotated: rotations.map((item) => ({
      tenantId: item.tenantId,
      companyName: item.companyName,
      format: `CT-${"*".repeat(10)}-${companySlug(item.companyName)}-${"*".repeat(10)}`,
      expiresAt: item.expiresAt,
    })),
    vercelUpdated: process.argv.includes("--vercel"),
    deliveryFile: keyDeliveryPath,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(closeAllPools);
