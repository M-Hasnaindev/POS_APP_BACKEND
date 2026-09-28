const assert=require('node:assert/strict');
const {cleanFilters,runLiveReport}=require('../services/liveIntelligenceService');
const {compileSalesReport}=require('../services/salesSemanticCompiler');
const {getReport}=require('../services/businessCatalogService');
const detail=['CompanyCode','Branch','CounterNo','TransactionNumber','TranDate','Cancel','NetAmount','Quantity','PurchasePrice'];
const header=['CompanyCode','Branch','CounterNo','TransactionNumber','BillStatus'];
const schema=[{name:'PosDetail',columns:detail},{name:'UnPosDetail',columns:detail},{name:'PosMaster',columns:header},{name:'UnPosMaster',columns:header}];
const filters=cleanFilters({fromDate:'2026-09-01',toDate:'2026-09-28'});
(async()=>{
  await assert.rejects(()=>runLiveReport({tenantId:'tenant_1'},{code:'anything'}),/Authenticated company/);
  for(const value of [{fromDate:'2026-02-30',toDate:'2026-03-01'},{fromDate:'2020-01-01',toDate:'2026-01-01'},{fromDate:"x'; DROP TABLE PosDetail;--",toDate:'2026-01-01'}])assert.throws(()=>cleanFilters(value));
  const plan=compileSalesReport(getReport('RPT_02_001_SALES_SUMMARY'),schema,filters,{isAdmin:false,companyCode:"T'T",branches:[]},{dialect:'mssql'});
  assert.match(plan.executionBatch,/CompanyCode"='T''T'/);
  assert.match(plan.executionBatch,/1=0/);
  assert.match(plan.executionBatch,/INTO #CherrySalesFacts/);
  assert.ok(!/\b(?:UPDATE|DELETE|INSERT INTO|ALTER|EXEC)\b/i.test(plan.executionBatch));
  assert.ok(!plan.executionBatch.includes('json_array'));
  console.log('PASS: authenticated company required, valid bounded dates, escaped literals, deny empty branch scope, temp-only writes.');
})().catch(error=>{console.error(error);process.exitCode=1});
