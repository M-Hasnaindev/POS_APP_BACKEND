const assert = require('node:assert/strict');
const { validateFilters, validDate, runReport } = require('../services/accountingReports');
const meta={branches:[{code:'B1'}],accounts:[{code:'A1',nature:'5',raw:{}}],agingSupported:true};
async function main(){
  assert.equal(validDate('2026-02-30'),false);
  assert.equal(validDate('2026-10-08'),true);
  assert.deepEqual(validateFilters({},meta).branchCodes,['B1']);
  assert.throws(()=>validateFilters({branchCodes:['B2']},meta),/Unauthorized/);
  assert.throws(()=>validateFilters({accountCodes:["A1';DROP"]},meta),/Invalid/);
  let query='',params={};
  const pool={request(){return {input(name,type,value){params[name]=value;return this;},async query(sql){query=sql;return {recordset:[]};}};}};
  const range={fromDate:'2026-10-01',toDate:'2026-10-08'};
  await runReport(pool,{companyCode:'C1',userId:'U1'},'month-wise-expense',range,meta);
  assert.equal(params.accounts,',A1,');assert.equal(params.branches,',B1,');assert.equal(params.mode,'MWR');
  await runReport(pool,{companyCode:'C1',userId:'U1'},'receivable-aging',range,meta);
  assert.match(query,/EXEC BillBalance/);assert.equal(params.party,'C');
  for(const report of ['balance-sheet','post-dated-cheques'])await assert.rejects(runReport(pool,{},report,range,meta),/requires/i);
  console.log('Accounting report validation, scope, modes and safety gates passed.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
