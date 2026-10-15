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
const { enforceAccess } = require("../middleware/accessRestriction");
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
    assert.equal(
      (
        await req(
          "/restrictions",
          "PUT",
          {
            scope: "company",
            tenantId: "t1",
            companyCode: "A",
            restricted: true,
            reason: "Test",
          },
          { Origin: "http://localhost:5173", "X-CSRF-Token": csrf },
        )
      ).status,
      200,
    );
    assert.equal(
      await store.checkAccess({
        tenantId: "t2",
        companyCode: "A",
        userId: "1",
      }),
      null,
    );
    assert.equal(
      await store.checkAccess({
        tenantId: "t1",
        companyCode: "B",
        userId: "1",
      }),
      null,
    );
    assert.ok(
      await store.checkAccess({
        tenantId: "t1",
        companyCode: "A",
        userId: "1",
      }),
    );
    await store.setRestriction({
      scope: "user",
      tenantId: "t1",
      companyCode: "B",
      userId: "1",
      restricted: true,
    });
    assert.equal(
      await store.checkAccess({
        tenantId: "t1",
        companyCode: "B",
        userId: "2",
      }),
      null,
    );
    let status, payload;
    const res = {
      status(n) {
        status = n;
        return this;
      },
      json(p) {
        payload = p;
        return this;
      },
    };
    assert.equal(
      await enforceAccess(
        { tenantId: "t1", companyCode: "A", userId: "1" },
        res,
        store,
      ),
      false,
    );
    assert.equal(status, 403);
    assert.equal(payload.code, "ACCESS_RESTRICTED");
    assert.equal(
      await enforceAccess({ tenantId: "t1", userId: "1" }, res, store),
      false,
    );
    assert.equal(status, 401);
    await enforceAccess(
      { tenantId: "t1", companyCode: "A", userId: "1" },
      res,
      {
        checkAccess: async () => {
          throw Error("offline");
        },
      },
    );
    assert.equal(status, 503);
    assert.equal(
      (
        await req(
          "/restrictions",
          "PUT",
          {
            scope: "company",
            tenantId: "t1",
            companyCode: "",
            restricted: true,
            reason: "Default company",
          },
          { Origin: "http://localhost:5173", "X-CSRF-Token": csrf },
        )
      ).status,
      200,
    );
    assert.ok(
      await store.checkAccess({
        tenantId: "t1",
        companyCode: "",
        userId: "default-user",
      }),
    );
    assert.equal(
      await store.checkAccess({
        tenantId: "t1",
        companyCode: "C",
        userId: "default-user",
      }),
      null,
    );
    assert.equal(
      await store.checkAccess({
        tenantId: "t2",
        companyCode: "",
        userId: "default-user",
      }),
      null,
    );
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
