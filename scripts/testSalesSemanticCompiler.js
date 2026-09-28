const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {compileSalesReport}=require('../services/salesSemanticCompiler');
const catalog=require('../ai/businessReportCatalog.json');
const db=new DatabaseSync(':memory:');
const header=['CompanyCode','Branch','CounterNo','TransactionNumber','BillStatus','CreditAccount'];
const detail=['CompanyCode','Branch','CounterNo','TransactionNumber','TranDate','Cancel','StoreCode','BarCode','NetAmount','Quantity','PurchasePrice'];
const schema=[{name:'PosMaster',columns:header},{name:'UnPosMaster',columns:header},{name:'PosDetail',columns:detail},{name:'UnPosDetail',columns:detail},{name:'BranchFile',columns:['BranchCode','BranchName']}];
for(const table of schema)db.exec(`CREATE TABLE ${table.name}(${table.columns.map(column=>`${column} ${['NetAmount','Quantity','PurchasePrice'].includes(column)?'REAL':'TEXT'}`).join(',')})`);
const put=(table,row)=>db.prepare(`INSERT INTO ${table} VALUES(${row.map(()=>'?').join(',')})`).run(...row);
for(const branch of ['A','B']){put('BranchFile',[branch,`Branch ${branch}`]);put('PosMaster',['TT',branch,'1','T1','P','acct']);}
put('PosMaster',['TT','A','1','T1','P','acct']); // duplicate header must not multiply sales
put('PosMaster',['TT','A','1','T2','P','acct']);
put('PosDetail',['TT','A','1','T1','2026-09-10','N','S','X',100,1,40]);
put('PosDetail',['TT','B','1','T1','2026-09-10','N','S','X',200,2,50]);
put('PosDetail',['TT','A','1','T2','2026-09-10','N','S','X',-20,-1,10]);
put('PosDetail',['TT','A','1','T1','2026-09-10','Y','S','X',999,99,10]);
put('UnPosMaster',['TT','A','1','T1','P','acct']);
put('UnPosDetail',['TT','A','1','T1','2026-09-10','N','S','X',100,1,40]);
const filters={fromDate:'2026-09-01',toDate:'2026-09-28',branches:[],stores:[],accounts:[],products:{}};
let tested=0;
for(const report of catalog){
  const plan=compileSalesReport(report,schema,filters,{isAdmin:true});if(!plan)continue;
  const results=Object.fromEntries(plan.queries.map(query=>[query.id,db.prepare(query.sql).all()]));
  assert.equal(results.totals[0].NetSales,280);
  assert.equal(results.totals[0].GrossProfit,150);
  assert.equal(results.totals[0].NetQuantity,2);
  assert.equal(results.totals[0].ReturnQuantity,1);
  assert.equal(results.totals[0].Bills,3);
  assert.deepEqual(results.totals,results.check);tested++;
}
const restricted=compileSalesReport(catalog.find(report=>report.code==='RPT_02_001_SALES_SUMMARY'),schema,filters,{isAdmin:false,branches:['A']});
assert.equal(db.prepare(restricted.queries[0].sql).get().NetSales,80);
db.close();console.log(`PASS: ${tested} compiled report routes; branch/counter document keys, duplicate headers, signed returns, cancellation, closed/unclosed deduplication, permissions and reconciliation.`);
