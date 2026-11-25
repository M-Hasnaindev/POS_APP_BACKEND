// Each tenant's own DB_n_SERVER / DB_n_PORT wins; the shared DB_SERVER / DB_PORT
// is only required when a tenant does not set its own.
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const tenantsPath = path.resolve(__dirname, "../config/tenants.js");
function load(env) {
  const saved = { ...process.env };
  const cwd = process.cwd();
  // dotenv reads ./.env from the working directory; use an empty one.
  process.chdir(os.tmpdir());
  for (const key of Object.keys(process.env)) if (/^(DB_|JWT_)/.test(key)) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[tenantsPath];
  try { return require(tenantsPath); }
  finally { process.chdir(cwd); process.env = saved; }
}
const base = { DB_USER: "u", DB_PASSWORD: "p", DB_1_DATABASE: "ONE", DB_1_KEY: "k1", DB_2_DATABASE: "TWO", DB_2_KEY: "k2" };

// Every tenant has its own server: the shared DB_SERVER / DB_PORT are not needed.
let { tenants } = load({ ...base, DB_1_SERVER: "erp4.example.com", DB_1_PORT: "51433", DB_2_SERVER: "erp5.example.com", DB_2_PORT: "2025" });
assert.deepEqual(tenants.map((t) => [t.config.server, t.config.port]), [["erp4.example.com", 51433], ["erp5.example.com", 2025]]);

// A tenant without its own server falls back to the shared one.
({ tenants } = load({ ...base, DB_SERVER: "shared.example.com", DB_PORT: "1433", DB_2_SERVER: "erp4.example.com", DB_2_PORT: "51433" }));
assert.deepEqual(tenants.map((t) => [t.config.server, t.config.port]), [["shared.example.com", 1433], ["erp4.example.com", 51433]]);

// Neither the tenant nor the shared value: a clear error names the missing variable.
assert.throws(() => load({ ...base, DB_1_SERVER: "erp4.example.com", DB_1_PORT: "51433" }), /Missing required environment variable: DB_SERVER/);

console.log("PASS: tenant server/port come from DB_n_SERVER / DB_n_PORT; shared DB_SERVER / DB_PORT only when a tenant has none.");
