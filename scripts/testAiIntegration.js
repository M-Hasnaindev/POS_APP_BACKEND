require("dotenv").config({ quiet: true });
const assert = require("assert");
const jwt = require("jsonwebtoken");
const app = require("../app");
const { getPoolForTenant, closeAllPools } = require("../config/db");

async function main() {
  const pool = await getPoolForTenant("tenant_1");
  const identity = (await pool.request().query("SELECT TOP 1 UserID,CompanyCode FROM Security WHERE UserID IS NOT NULL")).recordset[0];
  assert(identity, "A tenant_1 test identity is required");
  const token = jwt.sign({ type:"access", userId:identity.UserID, companyCode:identity.CompanyCode, tenantId:"tenant_1" }, process.env.JWT_SECRET, { expiresIn:"5m" });
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/ai`;
  const headers = { Authorization:`Bearer ${token}`, "Content-Type":"application/json" };
  try {
    const catalogResponse = await fetch(`${base}/reports`, { headers });
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalog.reports.length, 460);
    assert.equal(new Set(catalog.reports.map((report) => report.uiVariant)).size, 460);
    assert(catalog.reports.some((report) => report.code === "RPT_02_001_SALES_SUMMARY" && report.available));
    assert(catalog.reports.some((report) => report.code === "RPT_25_001_BRANCH_TARGET_INCENTIVE" && !report.available));

    const schemaCatalogResponse = await fetch(`${base}/catalog`, { headers });
    const schemaCatalog = await schemaCatalogResponse.json();
    assert.equal(schemaCatalogResponse.status, 200);
    const liveObjectNames = new Set(schemaCatalog.tables.map((table) => String(table.name).toLowerCase()));
    [
      "BarcodeView", "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail",
      "PosPurchaseM", "PosPurchaseD", "PosPReturnM", "PosPReturnD",
      "PosStockAdjM", "PosStockAdjD", "PosTransferM", "PosTransferD",
      "PosBarOpen", "PosBarcodeAdjM", "PosBarcodeAdjD",
    ].forEach((table) => assert(liveObjectNames.has(table.toLowerCase()), `${table} must be present in live AI catalog`));

    const filtersResponse = await fetch(`${base}/filters?kind=branches`, { headers });
    const filters = await filtersResponse.json();
    assert.equal(filtersResponse.status, 200);
    assert(Array.isArray(filters.options));

    const reportResponse = await fetch(`${base}/reports/RPT_02_001_SALES_SUMMARY/run`, {
      method:"POST", headers,
      body:JSON.stringify({ filters:{ fromDate:"2026-08-31", toDate:"2026-08-31" }, includeInsight:false }),
    });
    const report = await reportResponse.json();
    assert.equal(reportResponse.status, 200, report.message);
    assert.equal(report.report.source, "live-database");
    assert(Array.isArray(report.report.kpis));

    const greetingResponse = await fetch(`${base}/assistant`, {
      method:"POST", headers, body:JSON.stringify({ message:"salam", history:[] }),
    });
    const greeting = await greetingResponse.json();
    assert.equal(greetingResponse.status, 200);
    assert.equal(greeting.result.mode, "direct");

    const tenant2Pool = await getPoolForTenant("tenant_2");
    const tenant2Identity = (await tenant2Pool.request().query("SELECT TOP 1 UserID,CompanyCode FROM Security WHERE UserID IS NOT NULL")).recordset[0];
    assert(tenant2Identity, "A tenant_2 test identity is required");
    const tenant2Token = jwt.sign({ type:"access", userId:tenant2Identity.UserID, companyCode:tenant2Identity.CompanyCode, tenantId:"tenant_2" }, process.env.JWT_SECRET, { expiresIn:"5m" });
    const tenant2Health = await fetch(`${base}/health`, { headers:{ Authorization:`Bearer ${tenant2Token}` } });
    const tenant2Body = await tenant2Health.json();
    assert.equal(tenant2Health.status, 200);
    assert.equal(tenant2Body.tenantId, "tenant_2");
    console.log("AI HTTP integration tests passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await closeAllPools();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
