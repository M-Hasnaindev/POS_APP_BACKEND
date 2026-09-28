const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {compileForecastReport,forecastWindow}=require('../services/forecastSemanticCompiler');
const catalog=require('../ai/businessReportCatalog.json');
const db=new DatabaseSync(':memory:');
const header=['CompanyCode','Branch','CounterNo','TransactionNumber','BillStatus','CreditAccount'];
const detail=['CompanyCode','Branch','CounterNo','TransactionNumber','TranDate','Cancel','StoreCode','BarCode','NetAmount','Quantity','PurchasePrice'];
const attributes=['DesignNo','Brand','Catagory','Department','Season','Gender','Size','Color','CoBrandClass'];
const schema=[{name:'PosMaster',columns:header},{name:'UnPosMaster',columns:header},{name:'PosDetail',columns:detail},{name:'UnPosDetail',columns:detail},{name:'BranchFile',columns:['BranchCode','BranchName']},{name:'StockRoom',columns:['Code','Name','Branch']},{name:'BarcodeView',columns:['BarCode',...attributes.flatMap(name=>[name,name+'Name'])]}];
for(const table of schema)db.exec(`CREATE TABLE ${table.name}(${table.columns.map(column=>`${column} ${['NetAmount','Quantity','PurchasePrice'].includes(column)?'REAL':'TEXT'}`).join(',')})`);
const put=(table,row)=>db.prepare(`INSERT INTO ${table} VALUES(${row.map(()=>'?').join(',')})`).run(...row);
put('BranchFile',['A','Main branch']);put('StockRoom',['S','Main store','A']);put('BarcodeView',['X',...attributes.flatMap(name=>[name+'1',name+' name'])]);
for(const [index,date] of ['2026-09-01','2026-09-08','2026-09-15','2026-09-22'].entries()){
  put('PosMaster',['TT','A','1','T'+index,'P','acct']);
  put('PosDetail',['TT','A','1','T'+index,date,'N','S','X',70*(index+1),7*(index+1),3]);
}
const filters={fromDate:'2026-09-22',toDate:'2026-09-28',branches:[],stores:[],accounts:[],products:{}};
let tested=0;
for(const report of catalog){
  const plan=compileForecastReport(report,schema,filters,{isAdmin:true});if(!plan)continue;
  const results=Object.fromEntries(plan.queries.map(query=>[query.id,db.prepare(query.sql).all()]));
  const total=results.totals[0],window=forecastWindow(report,filters);
  assert.equal(total.P1Amount,210);assert.equal(total.P2Amount,140);assert.equal(total.P3Amount,70);assert.equal(total.ActualAmount,280);
  assert.equal(total.ForecastAmount,20*window.horizon);assert.equal(total.ForecastQty,2*window.horizon);assert.equal(total.ForecastProfit,14*window.horizon);
  assert.equal(total.GrowthPercent,-50);assert.ok(Math.abs(total.ConfidencePercent-66.6666666667)<1e-7);
  assert.deepEqual(results.totals,results.check);assert.equal(results.detail.reduce((sum,row)=>sum+row.ForecastAmount,0),total.ForecastAmount);
  assert.match(plan.assumptions.join(' '),/not a statistical probability/);tested++;
}
const report=catalog.find(report=>report.code==='RPT_08_001_AI_TOTAL_SALES_FORECAST');
const empty=compileForecastReport(report,schema,{...filters,branches:['missing']},{isAdmin:true});
assert.equal(db.prepare(empty.queries[0].sql).get().ConfidencePercent,null);
assert.equal(db.prepare(empty.queries[0].sql).get().ForecastAmount,null);
assert.throws(()=>forecastWindow(report,{fromDate:'bad',toDate:'bad'}));
db.close();console.log(`PASS: ${tested} forecasts, three historical windows, zero-sale days, explicit horizons, growth, disclosed stability score, empty data and totals reconciliation.`);
