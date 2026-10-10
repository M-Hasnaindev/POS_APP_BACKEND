const assert=require('node:assert/strict');
const db=require('../config/db');
const lookup=require('../services/accountingFilterOptions');
const original={Transaction:db.sql.Transaction,Request:db.sql.Request,load:lookup.loadAccountingFilterOptions};
let calls=[],fail=false;
lookup.loadAccountingFilterOptions=async()=>({branches:[{BranchCode:'01'}],accounts:[],levels:[{Row:0}]});
class Transaction{async begin(){calls.push('begin');}async rollback(){calls.push('rollback');}}
class Request{constructor(){this.params={};}input(k,t,v){this.params[k]=v;return this;}async query(q){calls.push(q);if(q.startsWith('EXEC AccProc')){assert.equal(this.params.p5,'USER1');assert.equal(this.params.p16,',01,');if(fail)throw new Error('database failure');return {recordset:[{ActCod:'1',Debit:5}]};}return {recordsets:[[],[]]};}}
db.sql.Transaction=Transaction;db.sql.Request=Request;
delete require.cache[require.resolve('../services/accountingReports')];
const {executeAccountingReport}=require('../services/accountingReports');
(async()=>{try{const args=[{},{userId:'USER1',companyCode:'UR'},'accounting-ledger',{fromDate:'2026-10-01',toDate:'2026-10-10'}];const result=await executeAccountingReport(...args);assert.equal(result.rows[0].Debit,5);assert.equal(calls[0],'begin');assert.equal(calls.at(-1),'rollback');assert(calls.some(q=>q.includes('sp_getapplock')));calls=[];fail=true;await assert.rejects(()=>executeAccountingReport(...args),/database failure/);assert.equal(calls.at(-1),'rollback');console.log('PASS: execution uses authenticated SQL user, branch expansion, application lock, and rollback on both success and failure');}finally{db.sql.Transaction=original.Transaction;db.sql.Request=original.Request;lookup.loadAccountingFilterOptions=original.load;}})().catch(e=>{console.error(e);process.exitCode=1;});
