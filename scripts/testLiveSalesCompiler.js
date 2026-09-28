// Read-only source check. Uses an empty future reporting period; only temporary
// SQL Server tables are written. No POS record or schema is modified.
const assert=require('node:assert/strict');
const {getManifest}=require('../services/knowledgeResourceService');
const {compileReport:compileSalesReport,supportsLive}=require('../services/deterministicReportCompiler');
const {getReport}=require('../services/businessCatalogService');
const {getPoolForTenant,closeAllPools}=require('../config/db');
(async()=>{
  const tenantId=process.env.TEST_TENANT||'tenant_1',companyCode=process.env.TEST_COMPANY||'TT';
  const manifest=await getManifest({tenantId,companyCode,isAdmin:true});
  const schema=manifest.resources.filter(table=>table.objectType!=='UNAVAILABLE').map(table=>({name:table.name,columns:table.columns.map(column=>column.name)}));
  const reports=process.argv[2]==='--all'?require('../ai/businessReportCatalog.json').filter(report=>supportsLive(report.code)):[getReport(process.argv[2]||'RPT_02_010_BRAND_WISE_SALES')];
  for(const report of reports){
  const plan=compileSalesReport(report,schema,{fromDate:'2099-01-01',toDate:'2099-01-01',branches:[],stores:[],accounts:[],products:{}},{isAdmin:true,companyCode},{dialect:'mssql'});
  assert.ok(plan.executionBatch);assert.ok(!plan.executionBatch.includes('LIMIT'));
  const request=(await getPoolForTenant(tenantId)).request();request.timeout=45000;
  const result=await request.query(plan.executionBatch);
  assert.equal(result.recordsets.length,3);
  assert.deepEqual(result.recordsets[0],result.recordsets[2]);
  const totals=result.recordsets[0][0];
  assert.equal(totals.NetSales??totals.ActualAmount??totals.PurchaseAmount??totals.PurchaseReturnAmount,0);
  console.log(`PASS: ${report.code} compiles and reconciles on live SQL Server (empty future period).`);
  }
})().catch(error=>{console.error(error.message);process.exitCode=1}).finally(closeAllPools);
