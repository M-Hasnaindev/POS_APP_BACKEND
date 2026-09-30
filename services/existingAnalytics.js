/* Shared deterministic analytics contract. Keep both repository copies identical. */
const definitions = [
 ['sales-summary','Sales & profit overview','Sales growth',null,'sales','NetSales'],
 ['sales-trend','Daily sales trend','Sales growth','day','sales','NetSales'],
 ['branch-sales','Branch performance','Sales growth','BranchName','sales','NetSales'],
 ['brand-sales','Brand performance','Product opportunities','BrandName','sales','NetSales'],
 ['category-sales','Category performance','Product opportunities','CatagoryName','sales','NetSales'],
 ['season-sales','Season performance','Product opportunities','SeasonName','sales','NetSales'],
 ['product-sales','Product performance','Product opportunities','BarCode','sales','NetSales'],
 ['discounts','Discount impact','Sales growth','BranchName','sales','Discount'],
 ['returns','Sales returns watch','Product opportunities','BarCode','sales','ReturnQuantity'],
 ['profit','Product profit contribution','Product opportunities','BarCode','sales','GrossProfit'],
 ['stock-summary','Stock investment overview','Stock decisions',null,'stock','StockValue'],
 ['branch-stock','Branch stock investment','Stock decisions','BranchName','stock','StockValue'],
 ['brand-stock','Brand stock investment','Stock decisions','BrandName','stock','StockValue'],
 ['category-stock','Category stock investment','Stock decisions','CatagoryName','stock','StockValue'],
 ['season-stock','Season stock investment','Stock decisions','SeasonName','stock','StockValue'],
 ['transit','Transfers & in-transit stock','Stock decisions','BranchName','stock','InTransitQty'],
 ['movement','Product movement & stock cover','Stock decisions','BarCode','stock','StockQty'],
 ['store-stock','Store stock investment','Stock decisions','StoreName','stock','StockValue'],
];
const presentation = {
 'sales-summary':['none','executive-overview'], 'sales-trend':['area','time-series'],
 'branch-sales':['ranked','branch-league'], 'brand-sales':['donut','brand-share'],
 'category-sales':['pie','category-mix'], 'season-sales':['column','season-profile'],
 'product-sales':['bar','product-ranking'], 'discounts':['donut','discount-composition'],
 'returns':['ranked','exception-watch'], 'profit':['progress','profit-contribution'],
 'stock-summary':['none','investment-overview'], 'branch-stock':['donut','branch-investment'],
 'brand-stock':['pie','brand-investment'], 'category-stock':['column','category-investment'],
 'season-stock':['bar','season-investment'], 'transit':['ranked','stock-flow'],
 'movement':['progress','movement-cover'], 'store-stock':['donut','store-investment'],
};
const reports=definitions.map(([code,name,category,dimension,mode,metric],i)=>({
 id:i+1,uiVariant:i+1,code:'GROW_'+code,name,category,dimension,mode,family:mode,uiFamily:presentation[code][1],chartType:presentation[code][0],
 metrics:[metric],advice:mode==='sales'?'Compare contribution before changing purchasing or promotion.':'Review stock and movement before replenishment.',
 descriptionLines:[mode==='sales'?'Sales Dashboard ke synced transaction data se sales, quantity aur historical cost-based profit samjhein.':'Stock Room ke latest procedure snapshot se investment aur movement samjhein. Ye historical daily stock ledger nahi hai.'],
 sourceDescriptionLines:['Existing Sales Dashboard / Stock Room data. No separate AI download.'],
}));
const quote=v=>"'"+String(v).replace(/'/g,"''")+"'";
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const attributes={brand:'BrandName',category:'CatagoryName',season:'SeasonName',style:'StyleName',color:'ColorName',size:'SizeName',design:'DesignNo',barcode:'BarCode',department:'DepartmentName'};
function compile(code,filters,permissions){
 const report=reports.find(r=>r.code===code);if(!report)throw Error('This report is not in the growth catalog.');
 const stock=report.mode==='stock',table=stock?'StockFacts':'SalesFacts',where=[];
 if(!validDate(filters.fromDate)||!validDate(filters.toDate)||filters.fromDate>filters.toDate)throw Error('Select a valid reporting period.');
 if(filters.accounts?.length)throw Error('Account-level facts are not included in the existing dashboard data.');
 if(!stock)where.push('date(BillDate) BETWEEN '+quote(filters.fromDate)+' AND '+quote(filters.toDate));
 for(const [key,column]of [['branches','Branch'],['stores','StoreCode']])if(filters[key]?.length)where.push(column+' IN ('+filters[key].map(quote).join(',')+')');
 for(const[key,value]of Object.entries(filters.products||{})){if(!value)continue;if(!attributes[key])throw Error('Unsupported filter: '+key);where.push(attributes[key]+'='+quote(value));}
 if(permissions){if(!permissions.isAdmin&&!permissions.branches?.length)where.push('0=1');else if(!permissions.isAdmin)where.push('Branch IN ('+permissions.branches.map(b=>quote(typeof b==='string'?b:b.BranchCode)).join(',')+')');}
 const condition=where.length?where.join(' AND '):'1=1';
 const metrics=stock?{StockQty:'StockQty',StockValue:'StockValue',InTransitQty:'InTransitQty',TransferInQty:'TransferInQty',TransferOutQty:'TransferOutQty',PeriodNetSoldQty:'SalesQty',PurchaseQty:'PurchaseQty'}:
 {NetSales:'NetAmount',NetQuantity:'Qty',GrossProfit:'GrossProfit',Discount:'TotalDiscount',ReturnQuantity:'CASE WHEN Qty<0 THEN -Qty ELSE 0 END'};
 const sums=Object.entries(metrics).map(([name,expr])=>'COALESCE(SUM('+expr+'),0) AS '+name).join(',');
 const dimension=report.dimension==='day'?'date(BillDate)':report.dimension==='BranchName'?'Branch':report.dimension==='StoreName'?'StoreCode':report.dimension;
 const label=report.dimension==='BarCode'?"COALESCE(MAX(NULLIF(DesignDesc,'')), 'Product') || ' (' || BarCode || ')'":report.dimension==='BranchName'?"COALESCE(MAX(NULLIF(BranchName,'')),Branch)":report.dimension==='StoreName'?"COALESCE(MAX(NULLIF(StoreName,'')),StoreCode)":dimension?"COALESCE(NULLIF(CAST("+dimension+" AS TEXT),''),'Unassigned')":"'Overall'";
 const base='SELECT '+label+' AS Label,'+sums+' FROM '+table+' WHERE '+condition;
 const cover=stock?',CASE WHEN SUM(SalesQty)>0 THEN SUM(StockQty)*(SELECT julianday(ToDate)-julianday(FromDate)+1 FROM BusinessCoverage WHERE Dataset=\'stock\')/SUM(SalesQty) ELSE NULL END AS EstimatedCoverDays':'';
 const detail='SELECT '+label+' AS Label,'+sums+cover+' FROM '+table+' WHERE '+condition+(dimension?' GROUP BY '+dimension:'')+' ORDER BY '+(report.dimension==='day'?'Label ASC':report.metrics[0]+' DESC')+' LIMIT 500';
 const totals='SELECT '+sums+' FROM '+table+' WHERE '+condition;
 const check='SELECT '+Object.keys(metrics).map(key=>'COALESCE(SUM('+key+'),0) AS '+key).join(',')+' FROM ('+base+(dimension?' GROUP BY '+dimension:'')+') grouped';
 const assumptions=[stock?'Stock figures cover the Stock Room snapshot period shown in data coverage, not arbitrary historical dates.':'Profit = synced NetAmount minus transaction CostAmountofSales, matching Sales Dashboard; it is not net accounting profit.',
 'No forecast, target, guaranteed growth or exact stock age is inferred from missing data.',
 'Detail shows at most 500 groups; totals include the full selected scope.'];
 return {title:report.name,detailLevel:'detailed',needsClarification:false,clarification:'',queries:[{id:'totals',purpose:'Full selected scope',sql:totals},{id:'detail',purpose:'Ranked business breakdown',sql:detail},{id:'check',purpose:'Grouped reconciliation',sql:check}],visualization:{type:report.chartType,queryId:'detail',labelKey:'Label',valueKey:report.metrics[0]},assumptions};
}
module.exports={reports,compile,attributes};
