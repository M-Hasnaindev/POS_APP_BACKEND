const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
let calls=[],fail=false,branches=[{BranchCode:'01'}];const pool={request:()=>({query:async q=>{assert.doesNotMatch(q,/\b(CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i);return{recordset:[]};}})};
class Transaction{async begin(){calls.push('begin');}async rollback(){calls.push('rollback');}}
class Request{constructor(tx){assert(tx instanceof Transaction);}async query(q){assert.match(q,/sp_getapplock/);calls.push('lock');}}
const sql={Transaction,Request,ISOLATION_LEVEL:{READ_COMMITTED:2}};
const http={sendSyncStream:async(_req,_res,run)=>{try{const meta=await run(async()=>calls.push('batch'),new AbortController().signal);assert.equal(calls.at(-1),'rollback');calls.push('complete');return meta;}catch{calls.push('error');}}};
const sources={
 '../config/db':{sql,getPoolForTenant:async id=>{assert.equal(id,'tenant-a');return pool;}},
 '../services/httpSyncStream':http,
 '../services/accountingService':{resolveAuthenticatedCompanyCode:async(_pool,user,company)=>{assert.equal(user,'user-a');return company;},resolveCompanyStartDate:async()=> '2026-06-01',pakistanToday:()=> '2026-10-23',executeAccountingSnapshot:async(_pool,input,batch)=>{assert.equal(input.userId,'user-a');assert.equal(input.companyCode,'UR');if(fail)throw Error('source');await batch([{Debit:1}]);return{count:1};}},
 '../services/branchPriceAccessService':{getBranchPriceAccess:async()=>({branches})},
 '../services/stockSnapshotService':{getStockSnapshot:async(input,batch)=>{assert.equal(input.branch,',01,');assert(input.transaction instanceof Transaction);assert.equal(input.tenantId,'tenant-a');if(fail)throw Error('source');await batch([{BalAmt:5}]);return{count:1};}}
};
function load(file){const out={};vm.runInNewContext(fs.readFileSync(file,'utf8'),{exports:out,require:n=>{assert(sources[n],n);return sources[n];}});return out;}
const accounting=load('controllers/accountingController.js'),stock=load('controllers/stockController.js');
const req={user:{tenantId:'tenant-a',userId:'user-a',companyCode:'UR'},headers:{},query:{fromDate:'2026-06-01',toDate:'2026-10-23',barcodeFrom:'0001',barcodeTo:'0999'}};
const res={status(n){this.code=n;return this;},json(value){this.body=value;return value;}};
(async()=>{
 for(const handler of [accounting.streamAccountingRecords,stock.streamSnapshot]){calls=[];fail=false;await handler(req,res);assert.deepEqual(calls,['begin','lock','batch','rollback','complete']);calls=[];fail=true;await handler(req,res);assert.deepEqual(calls,['begin','lock','rollback','error']);}
 fail=false;branches=[];calls=[];await stock.streamSnapshot(req,res);assert.equal(res.code,403);assert.deepEqual(calls,[]);
 await accounting.startAccountingRecordsJob(req,res);assert.equal(res.code,410);assert.equal(res.body.code,'LOCAL_SYNC_REQUIRED');
 console.log('PASS: source scope, stock branch access, rollback before completion, failure rollback, legacy update response; no live SQL used.');
})().catch(e=>{console.error(e);process.exitCode=1});
