const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {compilePurchaseReport}=require('../services/purchaseSemanticCompiler');
const catalog=require('../ai/businessReportCatalog.json'),db=new DatabaseSync(':memory:');
const header=['CompanyCode','Branch','TransactionNumber','Date','PartyCode','Cancel'];
const detail=['CompanyCode','Branch','TransactionNumber','BarCode','StoreCode','EntrySequence','DetBillAmount','Quantity','Cancel'];
const attributes=['DesignNo','Brand','Catagory','Size','Color','CoBrandClass'];
const schema=[...['PosPurchaseM','PosPReturnM'].map(name=>({name,columns:header})),...['PosPurchaseD','PosPReturnD'].map(name=>({name,columns:detail})),{name:'BarcodeView',columns:['BarCode',...attributes.flatMap(name=>[name,name+'Name'])]},{name:'AccountList',columns:['ActCod','AcName']}];
for(const table of schema)db.exec(`CREATE TABLE ${table.name}(${table.columns.map(column=>`${column} ${['DetBillAmount','Quantity'].includes(column)?'REAL':'TEXT'}`).join(',')})`);
const put=(table,row)=>db.prepare(`INSERT INTO ${table} VALUES(${row.map(()=>'?').join(',')})`).run(...row);
put('AccountList',['supplier1','Supplier one']);put('BarcodeView',['X',...attributes.flatMap(name=>[name+'-1',name+' name'])]);
for(const prefix of ['PosPurchase','PosPReturn']){
  put(prefix+'M',['TT','A','prev','2026-09-10','supplier1','N']);put(prefix+'D',['TT','A','prev','X','S','1',100,5,'N']);
  put(prefix+'M',['TT','A','current','2026-09-20','supplier1','N']);put(prefix+'M',['TT','A','current','2026-09-20','supplier1','N']);
  put(prefix+'D',['TT','A','current','X','S','1',150,5,'N']);put(prefix+'D',['TT','A','current','X','S','2',50,5,'N']);
  put(prefix+'D',['TT','A','current','X','S','3',999,9,'Y']);
  put(prefix+'M',['TT','B','current','2026-09-20','supplier1','Y']);put(prefix+'D',['TT','B','current','X','S','1',999,9,'N']);
}
const filters={fromDate:'2026-09-15',toDate:'2026-09-28',branches:[],stores:[],accounts:[],products:{}};
let count=0;
for(const report of catalog){
 const plan=compilePurchaseReport(report,schema,filters,{isAdmin:true});if(!plan)continue;
 const results=Object.fromEntries(plan.queries.map(query=>[query.id,db.prepare(query.sql).all()])),total=results.totals[0];
 assert.equal(total.PurchaseAmount??total.PurchaseReturnAmount,200);assert.equal(total.PurchaseQuantity??total.ReturnQuantity,10);assert.equal(total.AverageRate,20);assert.equal(total.PreviousAmount,100);assert.equal(total.GrowthPercent,100);assert.deepEqual(results.totals,results.check);
 if(report.code==='RPT_05_002_PURCHASE_INVOICE_DETAIL')assert.equal(results.detail.length,2); // selected-period lines, not old invoices
 if(report.dimension==='supplier')assert.equal(results.detail[0].Label,'Supplier one');
 const restricted=compilePurchaseReport(report,schema,filters,{isAdmin:false,branches:[]});assert.equal(db.prepare(restricted.queries[0].sql).get().PreviousAmount,0);
 count++;
}
console.log(`PASS: ${count} purchase/return reports; duplicate headers, cancellations, full document keys, line grouping, weighted rates, prior-period growth and branch restrictions.`);db.close();
