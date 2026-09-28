const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {compileSalesReport}=require('../services/salesSemanticCompiler');
const catalog=require('../ai/businessReportCatalog.json');
const db=new DatabaseSync(':memory:');
const header=['CompanyCode','Branch','CounterNo','TransactionNumber','BillStatus','CreditAccount'];
const detail=['CompanyCode','Branch','CounterNo','TransactionNumber','TranDate','Cancel','StoreCode','BarCode','NetAmount','Quantity','PurchasePrice'];
const schema=[{name:'PosMaster',columns:header},{name:'UnPosMaster',columns:header},{name:'PosDetail',columns:detail},{name:'UnPosDetail',columns:detail},{name:'BranchFile',columns:['BranchCode','BranchName']}];
const attributes=['DesignNo','Brand','CoBrand','Catagory','SubCatagory','Department','SubDepartment','Style','SubStyle','Season','Fabric','Gender','Size','Color'];
schema.push({name:'BarcodeView',columns:['BarCode',...attributes.flatMap(name=>[name,name+'Name'])]},{name:'StockRoom',columns:['Code','Name','Branch']});
for(const table of schema)db.exec(`CREATE TABLE ${table.name}(${table.columns.map(column=>`${column} ${['NetAmount','Quantity','PurchasePrice'].includes(column)?'REAL':'TEXT'}`).join(',')})`);
const put=(table,row)=>db.prepare(`INSERT INTO ${table} VALUES(${row.map(()=>'?').join(',')})`).run(...row);
put('BarcodeView',['X',...attributes.flatMap(name=>[name+'-code',name+' readable'])]);
put('BarcodeView',['X',...attributes.flatMap(name=>[name+'-code',name+' readable'])]); // duplicate reference must not multiply facts
put('StockRoom',['S','Main store','A']);put('StockRoom',['S','Other store','B']);
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
  assert.equal(results.totals[0].MarginPercent,150/280*100);
  assert.equal(results.detail.reduce((sum,row)=>sum+row.NetSales,0),280);
  if(report.dimension==='brand')assert.equal(results.detail[0].Label,'Brand readable');
  if(report.dimension==='store')assert.equal(results.detail.length,2);
  assert.deepEqual(results.totals,results.check);tested++;
}
const restricted=compileSalesReport(catalog.find(report=>report.code==='RPT_02_001_SALES_SUMMARY'),schema,filters,{isAdmin:false,branches:['A']});
assert.equal(db.prepare(restricted.queries[0].sql).get().NetSales,80);
const brandReport=catalog.find(report=>report.dimension==='brand'&&report.code.startsWith('RPT_02_'));
const filtered=compileSalesReport(brandReport,schema,{...filters,products:{brand:'Brand readable'}},{isAdmin:true});
assert.equal(db.prepare(filtered.queries[0].sql).get().NetSales,280);
const empty=compileSalesReport(brandReport,schema,{...filters,products:{brand:'missing'}},{isAdmin:true});
assert.equal(db.prepare(empty.queries[0].sql).get().MarginPercent,0);
const unsupported=catalog.find(report=>report.code==='RPT_02_026_NO_SALE_ITEMS');
assert.equal(compileSalesReport(unsupported,schema,filters,{isAdmin:true}),null);
db.close();console.log(`PASS: ${tested} compiled report routes; branch/counter document keys, duplicate headers, signed returns, cancellation, closed/unclosed deduplication, permissions and reconciliation.`);
