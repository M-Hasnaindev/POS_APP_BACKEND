const supported=new Set(['RPT_02_001_SALES_SUMMARY','RPT_02_002_DAILY_SALES','RPT_02_003_WEEKLY_SALES','RPT_02_004_MONTHLY_SALES','RPT_02_005_BRANCH_WISE_SALES']);
const quote=value=>'"'+String(value).replaceAll('"','""')+'"';
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";

function compileSalesReport(report,schema,filters,permissions={}){
  if(!supported.has(report.code))return null;
  const tables=new Map(schema.map(table=>[table.name.toLowerCase(),table]));
  const col=(table,name)=>tables.get(table.toLowerCase())?.columns.find(value=>value.toLowerCase()===name.toLowerCase());
  const field=(table,alias,name)=>{const found=col(table,name);if(!found)throw new Error(`${table}.${name} is required for verified sales`);return `${alias}.${quote(found)}`;};
  const keys=['CompanyCode','Branch','CounterNo','TransactionNumber'];
  const match=(detail,da,master,ma)=>keys.map(key=>`${field(detail,da,key)}=${field(master,ma,key)}`).join(' AND ');
  const productColumns={brand:'Brand',category:'Catagory',season:'Season',style:'Style',color:'Color',size:'Size',design:'DesignNo',barcode:'BarCode',fabric:'Fabric',department:'Department',gender:'Gender',cobrand:'CoBrand',subcategory:'SubCatagory',substyle:'SubStyle',styleclass:'StyleClass',styleclass1:'SubStyle1Class',styleclass2:'SubStyle2Class',subdepartment:'SubDepartment',fabricclass:'FabricClass',colorclass:'ColorClass'};
  const sources=[['PosDetail','PosMaster'],['UnPosDetail','UnPosMaster']].map(([detail,master])=>{
    const d=name=>field(detail,'d',name);
    const predicates=[`date(${d('TranDate')}) BETWEEN ${literal(filters.fromDate)} AND ${literal(filters.toDate)}`,`COALESCE(${d('Cancel')},'')<>'Y'`];
    for(const [values,column] of [[filters.branches,'Branch'],[filters.stores,'StoreCode'],[permissions.isAdmin?[]:permissions.branches||[],'Branch']])if(values?.length)predicates.push(`CAST(${d(column)} AS TEXT) IN (${values.map(literal).join(',')})`);
    let header=`${match(detail,'d',master,'m')} AND ${field(master,'m','BillStatus')}='P'`;
    if(filters.accounts?.length)header+=` AND CAST(${field(master,'m','CreditAccount')} AS TEXT) IN (${filters.accounts.map(literal).join(',')})`;
    predicates.push(`EXISTS(SELECT 1 FROM ${quote(master)} m WHERE ${header})`);
    if(detail==='UnPosDetail')predicates.push(`NOT EXISTS(SELECT 1 FROM PosMaster closed WHERE ${match(detail,'d','PosMaster','closed')})`);
    for(const [key,value] of Object.entries(filters.products||{})){
      const column=productColumns[key.toLowerCase().replace(/[^a-z]/g,'')];
      if(!column)throw new Error(`Sales filter ${key} needs a documented column mapping`);
      const productField=field('BarcodeView','p',column),name=col('BarcodeView',`${column}Name`);
      predicates.push(`EXISTS(SELECT 1 FROM BarcodeView p WHERE ${field('BarcodeView','p','BarCode')}=${d('BarCode')} AND (${productField}=${literal(value)}${name?` OR p.${quote(name)}=${literal(value)}`:''}))`);
    }
    return `SELECT json_array(${keys.map(key=>`CAST(${d(key)} AS TEXT)`).join(',')}) BillKey,date(${d('TranDate')}) SaleDate,${d('Branch')} Branch,${d('NetAmount')} NetSales,${d('Quantity')} NetQuantity,${d('Quantity')}*${d('PurchasePrice')} HistoricalCost,CASE WHEN ${d('Quantity')}<0 THEN -${d('Quantity')} ELSE 0 END ReturnQuantity FROM ${quote(detail)} d WHERE ${predicates.join(' AND ')}`;
  });
  const base=`WITH sales AS (${sources.join(' UNION ALL ')})`;
  const summary="COALESCE(SUM(NetSales),0) NetSales,COALESCE(SUM(NetQuantity),0) NetQuantity,COALESCE(SUM(NetSales-HistoricalCost),0) GrossProfit,COALESCE(SUM(ReturnQuantity),0) ReturnQuantity,COUNT(DISTINCT BillKey) Bills";
  let dimension="'Selected period'";
  if(report.dimension==='day')dimension='SaleDate';
  if(report.dimension==='week')dimension="strftime('%Y-%W',SaleDate)";
  if(report.dimension==='month')dimension="strftime('%Y-%m',SaleDate)";
  if(report.dimension==='branch')dimension=col('BranchFile','BranchName')?`COALESCE((SELECT MAX(b.${quote(col('BranchFile','BranchName'))}) FROM BranchFile b WHERE b.${quote(col('BranchFile','BranchCode'))}=sales.Branch),CAST(Branch AS TEXT))`:'CAST(Branch AS TEXT)';
  return {title:report.name,detailLevel:'detailed',needsClarification:false,clarification:'',queries:[
    {id:'totals',purpose:'Complete filtered sales totals',sql:`${base} SELECT ${summary} FROM sales`},
    {id:'detail',purpose:'Readable sales grouping',sql:`${base} SELECT ${dimension} Label,${summary} FROM sales GROUP BY ${dimension} ORDER BY Label LIMIT 500`},
    {id:'check',purpose:'Reconcile complete daily grouped facts',sql:`${base}, daily AS (SELECT SaleDate,SUM(NetSales) NetSales,SUM(NetQuantity) NetQuantity,SUM(NetSales-HistoricalCost) GrossProfit,SUM(ReturnQuantity) ReturnQuantity FROM sales GROUP BY SaleDate) SELECT COALESCE(SUM(NetSales),0) NetSales,COALESCE(SUM(NetQuantity),0) NetQuantity,COALESCE(SUM(GrossProfit),0) GrossProfit,COALESCE(SUM(ReturnQuantity),0) ReturnQuantity,(SELECT COUNT(DISTINCT BillKey) FROM sales) Bills FROM daily`},
  ],visualization:{type:report.dimension?(report.chartType==='none'?'bar':report.chartType):'none',queryId:'detail',labelKey:'Label',valueKey:'NetSales'}};
}
module.exports={compileSalesReport};
