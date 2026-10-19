process.env.ADMIN_EMAIL = "admin@example.test";
process.env.ADMIN_SESSION_SECRET = "test-secret-".repeat(5);
process.env.ADMIN_ALLOWED_ORIGINS = "http://localhost:5173";
process.env.ADMIN_PASSWORD_HASH = require("bcrypt").hashSync(
  "test-password",
  4,
);
const assert = require("node:assert/strict"),
  express = require("express"),
  jwt = require("jsonwebtoken");
const { createAdminRouter } = require("../routes/adminRoutes");
const sessions = new Map(),
  restrictions = [],
  tasks = [];
let attempts = 0;
const store = {
  rateLimit: async () => {
    if (++attempts > 1000)
      throw Object.assign(new Error("limited"), { statusCode: 429 });
  },
  createSession: async (sid, email, expiresAt) =>
    sessions.set(sid, { email, expiresAt }),
  session: async (sid) => sessions.get(sid),
  revokeSession: async (sid) => sessions.delete(sid),
  restrictions: async () => restrictions,
  tasks: async () => tasks,
  audit: async () => {},
  setRestriction: async (row) => restrictions.push(row),
  checkAccess: async (identity) =>
    restrictions.find(
      (r) =>
        r.restricted &&
        r.tenantId === identity.tenantId &&
        (r.scope === "tenant" ||
          (r.companyCode === identity.companyCode &&
            (r.scope === "company" || r.userId === identity.userId))),
    ) || null,
};
const dir = {
  tenants: [{ id: "t1", label: "One", key: "secret" }],
  tenantSummary: (t) => ({ id: t.id, label: t.label, key: "masked" }),
  validateScope: async (r) => {
    assert.equal(r.tenantId, "t1");
  },
  environment: () => ["TEST_APP_VALUE"],
  masked: () => "masked",
};
process.env.TEST_APP_VALUE = "test-only";
(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", createAdminRouter(store, dir));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api/admin`;
  let cookie = "",
    csrf = "";
  async function req(path, method = "GET", body, headers = {}) {
    return fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  try {
    assert.equal((await req("/overview")).status, 401);
    assert.equal((await req('/apps/pos/environment')).status, 401);
    assert.equal(
      (
        await req("/login", "POST", {
          email: process.env.ADMIN_EMAIL,
          password: "test-password",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await req(
          "/login",
          "POST",
          { email: process.env.ADMIN_EMAIL, password: "test-password" },
          { Origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    let r = await req(
      "/login",
      "POST",
      { email: process.env.ADMIN_EMAIL, password: "test-password" },
      { Origin: "http://localhost:5173" },
    );
    assert.equal(r.status, 200);
    cookie = r.headers.get("set-cookie").split(";")[0];
    assert.match(r.headers.get("set-cookie"), /HttpOnly/);
    assert.match(r.headers.get("set-cookie"), /Path=\/api\/admin/);
    csrf = (await r.json()).csrfToken;
    const scopedHeaders = {Origin:'http://localhost:5173','X-CSRF-Token':csrf};
    const maskedEnv = await (await req('/apps/pos/environment')).json();
    assert.equal(maskedEnv.variables[0].value,'masked');
    assert.equal((await req('/apps/pos/environment/reveal','POST',{names:['TEST_APP_VALUE'],password:'wrong'},scopedHeaders)).status,401);
    assert.equal((await req('/apps/pos/environment/reveal','POST',{names:['ADMIN_SESSION_SECRET'],password:'test-password'},scopedHeaders)).status,400);
    const revealedEnv = await (await req('/apps/pos/environment/reveal','POST',{names:['TEST_APP_VALUE'],password:'test-password'},scopedHeaders)).json();
    assert.equal(revealedEnv.variables[0].value,'test-only');
    assert.equal((await req('/apps/pos/environment/download','POST',{password:'test-password'},{Origin:'http://localhost:5173'})).status,403);
    const exportedEnv = await req('/apps/pos/environment/download','POST',{password:'test-password'},scopedHeaders);
    assert.match(exportedEnv.headers.get('content-disposition'),/pos-environment.env/);
    assert.match(await exportedEnv.text(),/TEST_APP_VALUE/);
    assert.equal((await req("/overview")).status, 200);
    assert.equal(
      (await req("/logout", "POST", {}, { Origin: "http://localhost:5173" }))
        .status,
      403,
    );
    assert.equal(
      (
        await req(
          "/environment/reveal",
          "POST",
          { names: ["ADMIN_SESSION_SECRET"], password: "test-password" },
          { Origin: "http://localhost:5173", "X-CSRF-Token": csrf },
        )
      ).status,
      400,
    );
    // Historical rows must not become active again or be mutated by old panels.
    restrictions.push({scope:'user',tenantId:'t1',companyCode:'A',userId:'1',restricted:true});
    for (const path of ['/restrictions', '/apps/pos/restrictions']) {
      const result = await req(path, 'PUT', {scope:'user',tenantId:'t1',companyCode:'A',userId:'1',restricted:true}, {Origin:'http://localhost:5173','X-CSRF-Token':csrf});
      assert.equal(result.status, 410);
      assert.equal((await result.json()).code, 'POS_RESTRICTIONS_DISABLED');
    }
    assert.equal(restrictions.length, 1);
    const restrictionList = await (await req('/restrictions')).json();
    assert.deepEqual(restrictionList.restrictions, []);
    assert.equal(restrictionList.restrictionsEnabled, false);
    const saved = cookie;
    cookie =
      "cherrys_admin=" +
      jwt.sign(
        { type: "access", email: process.env.ADMIN_EMAIL, sid: "x" },
        process.env.ADMIN_SESSION_SECRET,
      );
    assert.equal((await req("/session")).status, 401);
    cookie =
      "cherrys_admin=" +
      jwt.sign(
        { type: "admin", email: process.env.ADMIN_EMAIL, sid: "x", csrf: "y" },
        process.env.ADMIN_SESSION_SECRET,
        { audience: "cherrys-admin", issuer: "cherrys-admin", expiresIn: -1 },
      );
    assert.equal((await req("/session")).status, 401);
    cookie = saved;
    assert.equal(
      (
        await req(
          "/logout",
          "POST",
          {},
          { Origin: "http://localhost:5173", "X-CSRF-Token": csrf },
        )
      ).status,
      200,
    );
    assert.equal((await req("/session")).status, 401);
    attempts = 1001;
    assert.equal(
      (
        await req(
          "/login",
          "POST",
          { email: process.env.ADMIN_EMAIL, password: "test-password" },
          { Origin: "http://localhost:5173" },
        )
      ).status,
      429,
    );
    console.log(
      "Admin security tests passed (mock store; no database writes).",
    );
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
