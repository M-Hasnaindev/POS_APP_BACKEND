const assert=require('node:assert/strict');
const service=require('../services/intelligenceService');
const {reports,compile}=require('../services/existingAnalytics');
const schema=[{name:'SalesFacts',columns:['BillDate','Branch','BranchName','Qty','NetAmount','GrossProfit','TotalDiscount']},{name:'StockFacts',columns:['StockQty','StockValue']},{name:'BusinessCoverage',columns:['Dataset','FromDate','ToDate','SyncedAt']}];
(async()=>{
 const permissions={isAdmin:false,branches:['A'],allowRetail:true,allowWholesale:false};
 const plan=await service.createPlan({question:'bhai aj ki total sales batao',history:[],schema,permissions});
 assert.equal(plan.queries.length,1);assert.match(plan.queries[0].sql,/SalesFacts/);assert.match(plan.queries[0].sql,/Branch IN \('A'\)/);assert.equal(plan.liveRequest,undefined);
 const follow=await service.createPlan({question:'branch wise batao',history:[{role:'user',content:'aj ki sales batao'}],schema,permissions});assert.equal(follow.visualization.type,'ranked');
 const catalog=require('../services/businessCatalogService').listReports();assert.equal(catalog.count,18);assert.ok(catalog.categories.every(c=>c.reports.every(r=>r.code.startsWith('GROW_'))));
 assert.equal(reports.length,18);
 assert.equal(new Set(reports.map(report=>report.uiFamily)).size,18);
 assert.equal(new Set(reports.map(report=>report.chartType)).size,8);
 const denied=compile('GROW_sales-summary',{fromDate:'2026-09-01',toDate:'2026-09-28'}, {isAdmin:false,branches:[]});assert.match(denied.queries[0].sql,/0=1/);
 console.log('PASS: existing-data assistant totals, follow-up, server branch scope, no live fallback, focused catalog');
})().catch(error=>{console.error(error);process.exitCode=1});
