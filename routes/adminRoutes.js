const express = require("express");
const crypto = require("node:crypto");
const { adminStore, fail } = require("../services/adminStore");
const auth = require("../services/adminAuth");
const directory = require("../services/adminDirectory");
const str = (value, max = 100) => {
  if (typeof value !== "string" || value.length > max)
    throw fail("Invalid field value.");
  return value.trim();
};
const uuid = (value) => {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))
    throw fail("Invalid task id.");
  return value;
};
function createAdminRouter(store = adminStore, dir = directory) {
  const router = express.Router();
  const apps = require('../services/adminApps').createApps(store, dir);
  const appDetails = require('../services/adminAppDetails').createAppDetails(apps, store, dir);
  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    res.removeHeader("Access-Control-Allow-Origin");
    try {
      auth.originGuard(req);
      next();
    } catch (e) {
      next(e);
    }
  });
  router.post("/login", async (req, res) =>
    res.json(await auth.login(req, res, store)),
  );
  router.use(async (req, res, next) => {
    try {
      req.admin = await auth.authenticate(req, store);
      next();
    } catch (e) {
      next(e);
    }
  });
  router.get("/session", (req, res) =>
    res.json({
      success: true,
      admin: { email: req.admin.email },
      csrfToken: req.admin.csrf,
      expiresAt: new Date(req.admin.exp * 1000).toISOString(),
    }),
  );
  router.get('/apps', async (req,res)=>res.json({success:true,apps:await apps.list()}));
  router.get('/apps/:id/info', async (req,res)=>res.json({success:true,info:await appDetails.info(req.params.id)}));
  router.get('/apps/:id/overview', async (req,res)=>res.json({success:true,overview:await appDetails.overview(req.params.id)}));
  router.get('/apps/:id/environment', async (req,res)=>res.json({success:true,variables:await appDetails.environment(req.params.id)}));
  router.post('/apps/:id/environment/reveal', async (req,res)=>{
    await auth.password(req,store);
    res.json({success:true,variables:await appDetails.reveal(req.params.id,req.body.names,req.admin.email)});
  });
  router.post('/apps/:id/environment/download', async (req,res)=>{
    await auth.password(req,store);
    const content = await appDetails.download(req.params.id,req.admin.email);
    res.set({'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="${req.params.id}-environment.env"`}).send(content);
  });
  router.post('/apps', async (req,res)=>{
    await auth.password(req,store);
    res.status(201).json({success:true,app:await apps.save(req.body,req.admin.email)});
  });
  router.patch('/apps/:id', async (req,res)=>{
    await auth.password(req,store);
    res.json({success:true,app:await apps.save(req.body,req.admin.email,req.params.id)});
  });
  router.post('/apps/:id/test', async (req,res)=>res.json({success:true,tenantCount:(await apps.tenants(req.params.id)).length}));
  router.get('/apps/:id/tenants', async (req,res)=>res.json({success:true,tenants:await apps.tenants(req.params.id)}));
  router.get('/apps/:id/tenants/:tenantId', async (req,res)=>res.json({success:true,...await apps.detail(req.params.id,req.params.tenantId)}));
  router.post('/apps/:id/tenants/:tenantId/key/reveal', async (req,res)=>{
    await auth.password(req,store);
    res.json({success:true,key:await apps.revealKey(req.params.id,req.params.tenantId,req.admin.email)});
  });
  router.put('/apps/:id/restrictions', async (req,res)=>{
    const b=req.body;
    if(!['tenant','company','user'].includes(b.scope)||typeof b.restricted!=='boolean')throw fail('Invalid restriction.');
    const row={scope:b.scope,tenantId:str(b.tenantId),companyCode:b.scope==='tenant'?'':str(b.companyCode??''),userId:b.scope==='user'?str(b.userId):'',restricted:b.restricted,reason:str(b.reason??'',1000)};
    if(!row.tenantId||(row.scope==='user'&&!row.userId))throw fail('Restriction identity is required.');
    await apps.restrict(req.params.id,row,req.admin.email);
    res.json({success:true,restriction:row});
  });
  router.post("/logout", async (req, res) => {
    await store.revokeSession(req.admin.sid);
    auth.cookie(res, "", 0);
    res.json({ success: true });
  });
  router.get("/overview", async (req, res) => {
    const [r, t] = await Promise.all([store.restrictions(), store.tasks()]);
    const blocked = r.filter((x) => x.restricted);
    res.json({
      success: true,
      overview: {
        tenantCount: dir.tenants.length,
        restrictedTenants: blocked.filter((x) => x.scope === "tenant").length,
        restrictedCompanies: blocked.filter((x) => x.scope === "company")
          .length,
        restrictedUsers: blocked.filter((x) => x.scope === "user").length,
        openTasks: t.filter((x) => x.status !== "done").length,
        completedTasks: t.filter((x) => x.status === "done").length,
        updatedAt: new Date().toISOString(),
      },
    });
  });
  router.get("/tenants", (req, res) =>
    res.json({ success: true, tenants: dir.tenants.map(dir.tenantSummary) }),
  );
  router.get("/tenants/:id", async (req, res) =>
    res.json({
      success: true,
      ...(await dir.detail(req.params.id)),
      restrictions: (await store.restrictions()).filter(
        (x) => x.tenantId === req.params.id,
      ),
    }),
  );
  router.post("/tenants/:id/key/reveal", async (req, res) => {
    await auth.password(req, store);
    const t = dir.getTenantById(req.params.id);
    if (!t) throw fail("Tenant not found.", 404);
    await store.audit(req.admin.email, "tenant.key.revealed", t.id);
    res.json({ success: true, key: t.key });
  });
  router.get("/restrictions", async (req, res) =>
    res.json({ success: true, restrictions: await store.restrictions() }),
  );
  router.put("/restrictions", async (req, res) => {
    const b = req.body;
    if (
      !["tenant", "company", "user"].includes(b.scope) ||
      typeof b.restricted !== "boolean"
    )
      throw fail("Invalid restriction.");
    const row = {
      scope: b.scope,
      tenantId: str(b.tenantId),
      companyCode: b.scope === "tenant" ? "" : str(b.companyCode ?? ""),
      userId: b.scope === "user" ? str(b.userId) : "",
      restricted: b.restricted,
      reason: str(b.reason ?? "", 1000),
    };
    if (row.scope === "user" && !row.userId)
      throw fail("Restriction identity is required.");
    await dir.validateScope(row);
    await store.setRestriction(row, req.admin.email);
    res.json({ success: true, restriction: row });
  });
  router.get("/environment", (req, res) =>
    res.json({
      success: true,
      variables: dir.environment().map((name) => ({
        name,
        value: dir.masked(process.env[name]),
        configured: Boolean(process.env[name]),
      })),
    }),
  );
  router.post("/environment/reveal", async (req, res) => {
    await auth.password(req, store);
    const names = req.body.names;
    if (
      !Array.isArray(names) ||
      names.length > 100 ||
      !names.every((n) => dir.environment().includes(n))
    )
      throw fail("Invalid environment selection.");
    await store.audit(
      req.admin.email,
      "environment.revealed",
      names.join(",").slice(0, 500),
    );
    res.json({
      success: true,
      variables: names.map((name) => ({
        name,
        value: process.env[name] || "",
      })),
    });
  });
  router.post("/environment/download", async (req, res) => {
    await auth.password(req, store);
    await store.audit(
      req.admin.email,
      "environment.downloaded",
      "application allowlist",
    );
    res
      .set({
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="backend-environment.env"',
      })
      .send(
        dir
          .environment()
          .map(
            (name) =>
              name +
              "=" +
              require("../services/adminEnvironment").dotenvValue(
                process.env[name] || "",
              ),
          )
          .join("\n") + "\n",
      );
  });
  router.get("/tasks", async (req, res) =>
    res.json({ success: true, tasks: await store.tasks() }),
  );
  async function save(req, res, create) {
    const prior = create
      ? {}
      : (await store.tasks()).find(
          (t) => t.id.toLowerCase() === uuid(req.params.id).toLowerCase(),
        );
    if (!prior) throw fail("Task not found.", 404);
    const b = { ...prior, ...req.body };
    const task = {
      id: create ? crypto.randomUUID() : prior.id,
      title: str(b.title, 200),
      description: str(b.description ?? "", 10000),
      status: b.status || "todo",
      priority: b.priority || "normal",
      dueDate: b.dueDate ? new Date(b.dueDate) : null,
      tenantId: str(b.tenantId ?? ""),
      companyCode: str(b.companyCode ?? ""),
      userId: str(b.userId ?? ""),
    };
    if (
      !task.title ||
      !["todo", "in_progress", "done"].includes(task.status) ||
      !["low", "normal", "high"].includes(task.priority) ||
      (task.dueDate && !Number.isFinite(task.dueDate.getTime()))
    )
      throw fail("Invalid task fields.");
    if (task.tenantId)
      await dir.validateScope({
        ...task,
        scope: task.userId ? "user" : task.companyCode ? "company" : "tenant",
      });
    else if (task.companyCode || task.userId)
      throw fail("Select a tenant first.");
    res.status(create ? 201 : 200).json({
      success: true,
      task: await store.saveTask(task, req.admin.email, create),
    });
  }
  router.post("/tasks", (req, res) => save(req, res, true));
  router.patch("/tasks/:id", (req, res) => save(req, res, false));
  router.delete("/tasks/:id", async (req, res) => {
    await store.deleteTask(uuid(req.params.id), req.admin.email);
    res.json({ success: true });
  });
  router.get("/settings", (req, res) =>
    res.json({
      success: true,
      settings: {
        email: req.admin.email,
        sessionHours: 8,
        storeTenantId: process.env.ADMIN_STORE_TENANT_ID || "tenant_1",
      },
    }),
  );
  router.use((err, req, res, next) => {
    const status = err.statusCode || 503;
    res.status(status).json({
      success: false,
      code: err.code && err.statusCode ? err.code : "ADMIN_UNAVAILABLE",
      message: err.statusCode
        ? err.message
        : "Admin storage is temporarily unavailable.",
    });
  });
  return router;
}
module.exports = createAdminRouter();
module.exports.createAdminRouter = createAdminRouter;
