// Only explicitly supported descriptive reports: never reinterpret a forecast,
// no-sales population, or ranking report as an ordinary sales grouping.
const supported = code => /^RPT_02_(00[1-9]|01[0-9]|02[0-2])_/.test(code);
const quote=value=>'"'+String(value).replaceAll('"','""')+'"';
const literal=value=>"'"+String(value).replaceAll("'","''")+"'";

function compileSalesReport(report,schema,filters,permissions={},options={}){
  if(!supported(report.code))return null;
  const live=options.dialect==='mssql';
  const ref=name=>`${live?'dbo.':''}${quote(name)}`;
  const text=value=>`CAST(${value} AS ${live?'NVARCHAR(1000)':'TEXT'})`;
  const date=value=>live?`CONVERT(varchar(10),${value},23)`:`date(${value})`;
  // Length-prefixed tuple keys work on SQL Server 2014 as well as modern
  // servers, and cannot collide when a document field contains a separator.
  const tuple=values=>live?values.map(value=>`(CASE WHEN ${value} IS NULL THEN '-1:' ELSE CAST(DATALENGTH(${text(value)}) AS varchar(20))+':'+${text(value)} END)`).join("+'|'+"):`json_array(${values.join(',')})`;
  const joinLabel=values=>values.join(live?" + ' / ' + ":" || ' / ' || ");
  const tables=new Map(schema.map(table=>[table.name.toLowerCase(),table]));
  const col=(table,name)=>tables.get(table.toLowerCase())?.columns.find(value=>value.toLowerCase()===name.toLowerCase());
  const field=(table,alias,name)=>{const found=col(table,name);if(!found)throw new Error(`${table}.${name} is required for verified sales`);return `${alias}.${quote(found)}`;};
  const keys=['CompanyCode','Branch','CounterNo','TransactionNumber'];
  const match=(detail,da,master,ma)=>keys.map(key=>`${field(detail,da,key)}=${field(master,ma,key)}`).join(' AND ');
  const productColumns={brand:'Brand',category:'Catagory',season:'Season',style:'Style',color:'Color',size:'Size',design:'DesignNo',barcode:'BarCode',fabric:'Fabric',department:'Department',gender:'Gender',cobrand:'CoBrand',supplier:'CoBrandClass',subcategory:'SubCatagory',substyle:'SubStyle',styleclass:'StyleClass',styleclass1:'SubStyle1Class',styleclass2:'SubStyle2Class',subdepartment:'SubDepartment',fabricclass:'FabricClass',colorclass:'ColorClass'};
  const productMatch = (detail) => `${field('BarcodeView','p','BarCode')}=${field(detail,'d','BarCode')}${col('BarcodeView','CompanyCode')?` AND ${field('BarcodeView','p','CompanyCode')}=${field(detail,'d','CompanyCode')}`:''}`;
  const productValue = (detail, column) => `(SELECT MAX(${field('BarcodeView','p',column)}) FROM ${ref('BarcodeView')} p WHERE ${productMatch(detail)})`;
  function grouping(detail) {
    const d=name=>field(detail,'d',name);
    const nameLookup=(table,key,name,value,extra='')=>`COALESCE((SELECT MAX(${text(field(table,'r',name))}) FROM ${ref(table)} r WHERE ${field(table,'r',key)}=${value}${extra}),${text(value)},'Unassigned')`;
    switch(report.dimension){
      case null: case undefined:return ["'Selected period'","'Selected period'"];
      case 'day':return [date(d('TranDate')),date(d('TranDate'))];
      case 'week':{
        // Monday's date is an unambiguous cross-year week identifier.
        const week=live?`CONVERT(varchar(10),DATEADD(day,-((DATEDIFF(day,'19000101',${d('TranDate')})%7+7)%7),${d('TranDate')}),23)`:`date(${d('TranDate')},'-' || ((CAST(strftime('%w',${d('TranDate')}) AS INTEGER)+6)%7) || ' days')`;
        return [week,week];
      }
      case 'month':{const month=live?`CONVERT(varchar(7),${d('TranDate')},23)`:`strftime('%Y-%m',${d('TranDate')})`;return [month,month];}
      case 'branch':return [tuple([d('CompanyCode'),d('Branch')]),nameLookup('BranchFile','BranchCode','BranchName',d('Branch'),col('BranchFile','CompanyCode')?` AND ${field('BranchFile','r','CompanyCode')}=${d('CompanyCode')}`:'')];
      case 'store':return [tuple([d('CompanyCode'),d('Branch'),d('StoreCode')]),nameLookup('StockRoom','Code','Name',d('StoreCode'),` AND ${field('StockRoom','r','Branch')}=${d('Branch')}`)];
      case 'invoice':return [tuple(keys.map(d)),joinLabel(['Branch','CounterNo','TransactionNumber'].map(name=>text(d(name))))];
      case 'product':case 'barcode':return [d('BarCode'),text(d('BarCode'))];
      case 'supplier_product':return [tuple([productValue(detail,'CoBrandClass'),d('BarCode')]),joinLabel([`COALESCE(${text(productValue(detail,'CoBrandClassName'))},'Unassigned')`,text(d('BarCode'))])];
      case 'size_color':case 'substyle':{
        const columns=report.dimension==='size_color'?['Size','Color']:['Style','SubStyle'];
        return [tuple(columns.map(column=>productValue(detail,column))),joinLabel(columns.map(column=>`COALESCE(${text(productValue(detail,col('BarcodeView',column+'Name')||column))},'Unassigned')`))];
      }
      default:{
        const column=productColumns[report.dimension];
        if(!column)throw new Error(`Unsupported sales grouping: ${report.dimension}`);
        return [productValue(detail,column),`COALESCE(${text(productValue(detail,col('BarcodeView',column+'Name')||column))},'Unassigned')`];
      }
    }
  }
  const sources=[['PosDetail','PosMaster'],['UnPosDetail','UnPosMaster']].map(([detail,master])=>{
    const d=name=>field(detail,'d',name);
    const predicates=[`${date(d('TranDate'))} BETWEEN ${literal(filters.fromDate)} AND ${literal(filters.toDate)}`,`COALESCE(${d('Cancel')},'')<>'Y'`];
    if(permissions.companyCode)predicates.push(`${d('CompanyCode')}=${literal(permissions.companyCode)}`);
    if(live&&!permissions.isAdmin&&!permissions.branches?.length)predicates.push('1=0');
    for(const [values,column] of [[filters.branches,'Branch'],[filters.stores,'StoreCode'],[permissions.isAdmin?[]:permissions.branches||[],'Branch']])if(values?.length)predicates.push(`${text(d(column))} IN (${values.map(literal).join(',')})`);
    let header=`${match(detail,'d',master,'m')} AND ${field(master,'m','BillStatus')}='P'`;
    if(filters.accounts?.length)header+=` AND ${text(field(master,'m','CreditAccount'))} IN (${filters.accounts.map(literal).join(',')})`;
    predicates.push(`EXISTS(SELECT 1 FROM ${ref(master)} m WHERE ${header})`);
    if(detail==='UnPosDetail')predicates.push(`NOT EXISTS(SELECT 1 FROM ${ref('PosMaster')} closed WHERE ${match(detail,'d','PosMaster','closed')} AND ${field('PosMaster','closed','BillStatus')}='P')`);
    for(const [key,value] of Object.entries(filters.products||{})){
      const column=productColumns[key.toLowerCase().replace(/[^a-z0-9]/g,'')];
      if(!column)throw new Error(`Sales filter ${key} needs a documented column mapping`);
      const productField=field('BarcodeView','p',column),name=col('BarcodeView',column==='DesignNo'||column==='BarCode'?'DesignDesc':`${column}Name`);
      predicates.push(`EXISTS(SELECT 1 FROM ${ref('BarcodeView')} p WHERE ${productMatch(detail)} AND (${productField}=${literal(value)}${name?` OR p.${quote(name)}=${literal(value)}`:''}))`);
    }
    const [groupKey,groupLabel]=grouping(detail);
    return `SELECT ${groupKey} GroupKey,${groupLabel} GroupLabel,${tuple(keys.map(key=>text(d(key))))} BillKey,${date(d('TranDate'))} SaleDate,${d('Branch')} Branch,${d('NetAmount')} NetSales,${d('Quantity')} NetQuantity,${d('Quantity')}*${d('PurchasePrice')} HistoricalCost,CASE WHEN ${d('Quantity')}<0 THEN -${d('Quantity')} ELSE 0 END ReturnQuantity FROM ${ref(detail)} d WHERE ${predicates.join(' AND ')}`;
  });
  const base=`WITH sales AS (${sources.join(' UNION ALL ')})`;
  if(options.factsOnly)return {base};
  const summary="COALESCE(SUM(NetSales),0) NetSales,COALESCE(SUM(NetQuantity),0) NetQuantity,COALESCE(SUM(NetSales-HistoricalCost),0) GrossProfit,COALESCE(SUM(ReturnQuantity),0) ReturnQuantity,COUNT(DISTINCT BillKey) Bills,COALESCE(100.0*SUM(NetSales-HistoricalCost)/NULLIF(SUM(NetSales),0),0) MarginPercent";
  const plan={title:report.name,detailLevel:'detailed',needsClarification:false,clarification:'',queries:[
    {id:'totals',purpose:'Complete filtered sales totals',sql:`${base} SELECT ${summary} FROM sales`},
    {id:'detail',purpose:'Readable sales grouping',sql:`${base} SELECT ${live?'TOP (500) ':''}GroupKey,MAX(GroupLabel) Label,${summary} FROM sales GROUP BY GroupKey ORDER BY Label,GroupKey${live?'':' LIMIT 500'}`},
    {id:'check',purpose:'Reconcile complete daily grouped facts',sql:`${base}, daily AS (SELECT SaleDate,SUM(NetSales) NetSales,SUM(NetQuantity) NetQuantity,SUM(NetSales-HistoricalCost) GrossProfit,SUM(ReturnQuantity) ReturnQuantity FROM sales GROUP BY SaleDate) SELECT COALESCE(SUM(NetSales),0) NetSales,COALESCE(SUM(NetQuantity),0) NetQuantity,COALESCE(SUM(GrossProfit),0) GrossProfit,COALESCE(SUM(ReturnQuantity),0) ReturnQuantity,(SELECT COUNT(DISTINCT BillKey) FROM sales) Bills,COALESCE(100.0*SUM(GrossProfit)/NULLIF(SUM(NetSales),0),0) MarginPercent FROM daily`},
  ],visualization:{type:report.dimension?(report.chartType==='none'?'bar':report.chartType):'none',queryId:'detail',labelKey:'Label',valueKey:'NetSales'}};
  if(live){
    // Only generated SQL reaches execution. Materialize facts once in a
    // connection-local temp table; all three result sets see identical rows.
    plan.executionBatch=`SET NOCOUNT ON; SET QUOTED_IDENTIFIER ON; ${base} SELECT * INTO #CherrySalesFacts FROM sales; `+plan.queries.map(query=>`WITH sales AS (SELECT * FROM #CherrySalesFacts)${query.sql.slice(base.length)};`).join('\n')+' DROP TABLE #CherrySalesFacts;';
  }
  return plan;
}
module.exports={compileSalesReport};
