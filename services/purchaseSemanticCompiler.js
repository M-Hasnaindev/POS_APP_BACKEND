const supported=code=>/^RPT_05_00[1-9]_/.test(code);
const q=value=>'"'+String(value).replaceAll('"','""')+'"';
const lit=value=>"'"+String(value).replaceAll("'","''")+"'";
function compilePurchaseReport(report,schema,filters,permissions={},options={}){
  if(!supported(report.code))return null;
  const live=options.dialect==='mssql',isReturn=report.code==='RPT_05_009_PURCHASE_RETURN';
  const master=isReturn?'PosPReturnM':'PosPurchaseM',detail=isReturn?'PosPReturnD':'PosPurchaseD';
  const tables=new Map(schema.map(table=>[table.name.toLowerCase(),table.columns]));
  const col=(table,name)=>tables.get(table.toLowerCase())?.find(column=>column.toLowerCase()===name.toLowerCase());
  const f=(table,alias,name)=>{const column=col(table,name);if(!column)throw Object.assign(new Error(`${table}.${name} is required for verified purchase reports`),{status:422});return `${alias}.${q(column)}`;};
  const ref=table=>`${live?'dbo.':''}${q(table)}`,txt=value=>`CAST(${value} AS ${live?'NVARCHAR(1000)':'TEXT'})`;
  const date=value=>live?`CONVERT(varchar(10),${value},23)`:`date(${value})`;
  const tuple=values=>live?values.map(value=>`COALESCE(CAST(DATALENGTH(${txt(value)}) AS varchar(20))+':'+${txt(value)},'-1:')`).join("+'|'+"):`json_array(${values.join(',')})`;
  const d=name=>f(detail,'d',name),m=name=>f(master,'m',name),keys=['CompanyCode','Branch','TransactionNumber'];
  const match=keys.map(key=>`${d(key)}=${m(key)}`).join(' AND ');
  const header=`${match} AND COALESCE(${m('Cancel')},'')<>'Y'`;
  const headerValue=column=>`(SELECT MAX(${m(column)}) FROM ${ref(master)} m WHERE ${header})`;
  const transactionDate=date(headerValue('Date')),party=headerValue('PartyCode');
  const from=Date.parse(filters.fromDate),to=Date.parse(filters.toDate),days=Math.round((to-from)/86400000)+1;
  if(!Number.isFinite(days)||days<=0)throw new Error('Invalid purchase report period');
  const previousFrom=new Date(from-days*86400000).toISOString().slice(0,10);
  const attributes={brand:'Brand',category:'Catagory',season:'Season',style:'Style',color:'Color',size:'Size',design:'DesignNo',barcode:'BarCode',fabric:'Fabric',department:'Department',gender:'Gender',cobrand:'CoBrand',supplier:'CoBrandClass',subcategory:'SubCatagory',substyle:'SubStyle',styleclass:'StyleClass',styleclass1:'SubStyle1Class',styleclass2:'SubStyle2Class',subdepartment:'SubDepartment',fabricclass:'FabricClass',colorclass:'ColorClass'};
  const productMatch=`${f('BarcodeView','p','BarCode')}=${d('BarCode')}${col('BarcodeView','CompanyCode')?` AND ${f('BarcodeView','p','CompanyCode')}=${d('CompanyCode')}`:''}`;
  const product=column=>`(SELECT MAX(${f('BarcodeView','p',column)}) FROM ${ref('BarcodeView')} p WHERE ${productMatch})`;
  const predicates=[`COALESCE(${d('Cancel')},'')<>'Y'`,`EXISTS(SELECT 1 FROM ${ref(master)} m WHERE ${header})`,`${transactionDate} BETWEEN ${lit(previousFrom)} AND ${lit(filters.toDate)}`];
  if(permissions.companyCode)predicates.push(`${d('CompanyCode')}=${lit(permissions.companyCode)}`);
  if(permissions.isAdmin===false&&!permissions.branches?.length)predicates.push('1=0');
  for(const [values,value] of [[filters.branches,d('Branch')],[filters.stores,d('StoreCode')],[filters.accounts,party],[permissions.isAdmin?[]:permissions.branches,d('Branch')]])if(values?.length)predicates.push(`${txt(value)} IN (${values.map(lit).join(',')})`);
  for(const [key,value] of Object.entries(filters.products||{})){
    const column=attributes[key.toLowerCase().replace(/[^a-z0-9]/g,'')];if(!column)throw new Error(`Unsupported purchase product filter: ${key}`);
    const name=col('BarcodeView',column==='DesignNo'||column==='BarCode'?'DesignDesc':column+'Name');
    predicates.push(`EXISTS(SELECT 1 FROM ${ref('BarcodeView')} p WHERE ${productMatch} AND (${f('BarcodeView','p',column)}=${lit(value)}${name?` OR p.${q(name)}=${lit(value)}`:''}))`);
  }
  let groupKey,label;
  if(report.dimension==='invoice'){
    const values=keys.map(d);if(report.code==='RPT_05_002_PURCHASE_INVOICE_DETAIL')values.push(d('BarCode'),d('EntrySequence'));
    groupKey=tuple(values);label=values.map(txt).join(live?"+' / '+":"||' / '||");
  }else if(report.dimension==='supplier'){
    groupKey=party;label=`COALESCE((SELECT MAX(${txt(f('AccountList','a','AcName'))}) FROM ${ref('AccountList')} a WHERE ${f('AccountList','a','ActCod')}=${party}${col('AccountList','CompanyCode')?` AND ${f('AccountList','a','CompanyCode')}=${d('CompanyCode')}`:''}),${txt(party)},'Unassigned')`;
  }else if(report.dimension==='barcode'){groupKey=d('BarCode');label=txt(d('BarCode'));}
  else {
    const columns=report.code==='RPT_05_008_SIZE_COLOR_WISE_PURCHASE'?['Size','Color']:[attributes[report.dimension]];
    groupKey=tuple(columns.map(product));label=columns.map(column=>`COALESCE(${txt(product(col('BarcodeView',column+'Name')||column))},'Unassigned')`).join(live?"+' / '+":"||' / '||");
  }
  const base=`WITH purchases AS (SELECT ${groupKey} GroupKey,${label} Label,${transactionDate} TranDate,${d('DetBillAmount')} Amount,${d('Quantity')} Quantity FROM ${ref(detail)} d WHERE ${predicates.join(' AND ')})`;
  const aggregate=`COALESCE(SUM(CASE WHEN TranDate>=${lit(filters.fromDate)} THEN Amount ELSE 0 END),0) Amount,COALESCE(SUM(CASE WHEN TranDate>=${lit(filters.fromDate)} THEN Quantity ELSE 0 END),0) Quantity,COALESCE(SUM(CASE WHEN TranDate<${lit(filters.fromDate)} THEN Amount ELSE 0 END),0) PreviousAmount,COALESCE(SUM(CASE WHEN TranDate<${lit(filters.fromDate)} THEN Quantity ELSE 0 END),0) PreviousQuantity`;
  const output=`Amount ${isReturn?'PurchaseReturnAmount':'PurchaseAmount'},Quantity ${isReturn?'ReturnQuantity':'PurchaseQuantity'},Amount*1.0/NULLIF(Quantity,0) AverageRate,PreviousAmount,PreviousQuantity,100.0*(Amount-PreviousAmount)/NULLIF(ABS(PreviousAmount),0) GrowthPercent`;
  const plan={title:report.name,detailLevel:'detailed',needsClarification:false,clarification:'',assumptions:[`Amount uses ${detail}.DetBillAmount (final detail amount); quantity uses detail Quantity. Cancelled headers and lines are excluded.`,`Growth compares ${filters.fromDate}–${filters.toDate} with the immediately preceding ${days}-day period. A zero previous amount has unavailable growth, not 0% growth. Average rate is final amount / quantity.`,`Account filters select header PartyCode. Supplier merchandise filters select BarcodeView.CoBrandClass; they are different scopes.`],queries:[
    {id:'totals',purpose:'Full filtered purchase totals and previous-period comparison',sql:`${base}, summary AS (SELECT ${aggregate} FROM purchases) SELECT ${output} FROM summary`},
    {id:'detail',purpose:'Requested purchase grouping with readable names',sql:`${base}, summary AS (SELECT GroupKey,MAX(Label) Label,SUM(CASE WHEN TranDate>=${lit(filters.fromDate)} THEN 1 ELSE 0 END) CurrentRows,${aggregate} FROM purchases GROUP BY GroupKey) SELECT ${live?'TOP (500) ':''}GroupKey,Label,${output} FROM summary WHERE CurrentRows>0 ORDER BY Amount DESC,GroupKey${live?'':' LIMIT 500'}`},
    {id:'check',purpose:'Reconcile across complete grouped purchase facts',sql:`${base}, grouped AS (SELECT GroupKey,${aggregate} FROM purchases GROUP BY GroupKey), summary AS (SELECT COALESCE(SUM(Amount),0) Amount,COALESCE(SUM(Quantity),0) Quantity,COALESCE(SUM(PreviousAmount),0) PreviousAmount,COALESCE(SUM(PreviousQuantity),0) PreviousQuantity FROM grouped) SELECT ${output} FROM summary`}
  ],visualization:{type:'bar',queryId:'detail',labelKey:'Label',valueKey:isReturn?'PurchaseReturnAmount':'PurchaseAmount'}};
  if(live)plan.executionBatch=`SET NOCOUNT ON; SET QUOTED_IDENTIFIER ON; ${base} SELECT * INTO #CherryPurchaseFacts FROM purchases; `+plan.queries.map(query=>`WITH purchases AS (SELECT * FROM #CherryPurchaseFacts)${query.sql.slice(base.length)};`).join('\n')+' DROP TABLE #CherryPurchaseFacts;';
  return plan;
}
module.exports={compilePurchaseReport,supported};
