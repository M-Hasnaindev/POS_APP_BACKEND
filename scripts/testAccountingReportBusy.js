// A report that cannot get the per-company report lock (another report or a
// stock/accounting sync is running) waits in line, then fails with a clear
// 503 REPORT_BUSY instead of a generic 500.
const assert=require('node:assert/strict');
const db=require('../config/db');
const lookup=require('../services/accountingFilterOptions');
const original={Transaction:db.sql.Transaction,Request:db.sql.Request,load:lookup.loadAccountingFilterOptions};
let calls=[],lockWait=null;
lookup.loadAccountingFilterOptions=async()=>({branches:[{BranchCode:'01'}],accounts:[],levels:[{Row:0}]});
class Transaction{async begin(){calls.push('begin');}async rollback(){calls.push('rollback');}}
class Request{constructor(){this.params={};}input(k,t,v){this.params[k]=v;return this;}async query(q){calls.push(q);if(q.includes('sp_getapplock')){lockWait=this.params.lockWait;throw Object.assign(new Error('Report is busy. Retry shortly.'),{number:51000,code:'EREQUEST'});}return {recordset:[]};}}
db.sql.Transaction=Transaction;db.sql.Request=Request;
delete require.cache[require.resolve('../services/accountingReports')];
const {executeAccountingReport,REPORT_LOCK_WAIT_MS}=require('../services/accountingReports');
(async()=>{
 try{
  await assert.rejects(
   ()=>executeAccountingReport({},{userId:'USER1',companyCode:'UR'},'trial-balance',{fromDate:'2026-10-01',toDate:'2026-10-10'}),
   err=>err.statusCode===503&&err.code==='REPORT_BUSY'&&/another report or data sync/i.test(err.message),
  );
  assert.equal(lockWait,REPORT_LOCK_WAIT_MS,'reports wait for the running report or sync');
  assert(REPORT_LOCK_WAIT_MS>=30000,'wait long enough for a typical report to finish');
  assert(!calls.some(q=>String(q).startsWith('EXEC AccProc')),'the procedure never runs without the lock');
  assert.equal(calls.at(-1),'rollback');
  console.log('PASS: busy report lock waits in line, then returns 503 REPORT_BUSY with a clear message and rolls back');
 }finally{db.sql.Transaction=original.Transaction;db.sql.Request=original.Request;lookup.loadAccountingFilterOptions=original.load;}
})().catch(e=>{console.error(e);process.exitCode=1;});
