const {sql}=require('../config/db');
const {streamRows}=require('./streamRows');
const crypto=require('node:crypto');
const {projectionForMetadata}=require('./incomeStockProjection');
const filters=['Brand','CoBrand','CoBrandClass','Catagory','SubCatagory','Style','SubStyle','StyleClass','SubStyle1','SubStyle2','Department','SubDepartment','Season','Fabric','FabricClass','Color','ColorClass','Size','Gender'];
const fail=message=>Object.assign(new Error(message),{statusCode:422,code:'INCOME_SOURCE_INCOMPLETE'});
const timedOut=()=>Object.assign(new Error('Income Statement timed out. Please retry with fewer branches.'),{statusCode:504,code:'INCOME_SOURCE_TIMEOUT'});
function stockRequest(transaction,{companyCode,branchCodes,fromDate,toDate},barcode=''){
 const request=new sql.Request(transaction);
 request.input('CompanyCode',sql.VarChar(6),companyCode).input('Branch',sql.NVarChar(sql.MAX),','+branchCodes.join(',')+',').input('Store',sql.NVarChar(sql.MAX),'')
 .input('Startdate',sql.DateTime,new Date(fromDate+'T00:00:00Z')).input('DateFrom',sql.DateTime,new Date(fromDate+'T00:00:00Z')).input('DateTo',sql.DateTime,new Date(toDate+'T00:00:00Z'))
 .input('Userid',sql.NVarChar(sql.MAX),'POSINCOME').input('ReportType',sql.NVarChar(50),'7').input('BranchOptions',sql.NVarChar(50),'1').input('StoreOption',sql.NVarChar(50),'1').input('ValuationMethod',sql.NVarChar(50),'3').input('ReportName',sql.NVarChar(3),'004');
 for(const name of filters)request.input(name,sql.NVarChar(sql.MAX),'');
 request.input('Barcode',sql.NVarChar(sql.MAX),barcode).input('Design',sql.NVarChar(sql.MAX),'').input('IncludeZeroBal',sql.VarChar(1),'Y').input('BarCodeFr',sql.NVarChar(sql.MAX),'').input('BarCodeTo',sql.NVarChar(sql.MAX),'').input('RetailFr',sql.Float,0).input('RetailTo',sql.Float,0).input('IsNonInventory',sql.NVarChar(1),'Y');
 return request;
}
const quote=name=>'['+String(name).replace(/]/g,']]')+']';
function columnType(column){
 const type=column.type?.name;
 if(['NVarChar','VarChar','NChar','Char','Text','NText'].includes(type))return 'nvarchar(max)';
 if(['Float','Real'].includes(type))return 'float';
 if(['Numeric','Decimal'].includes(type)){
  const {precision,scale}=column;if(!Number.isInteger(precision)||!Number.isInteger(scale)||precision<1||precision>38||scale<0||scale>precision)throw fail('Stock valuation returned an unsupported numeric schema.');
  return `decimal(${precision},${scale})`;
 }
 if(['Int','SmallInt','TinyInt','BigInt','Bit'].includes(type))return 'bigint';
 if(['Money','SmallMoney'].includes(type))return 'decimal(19,4)';
 if(['Date','DateTime','DateTime2','SmallDateTime'].includes(type))return 'datetime2';
 if(['VarBinary','Binary','Image'].includes(type))return 'varbinary(max)';
 throw fail('Stock valuation returned an unsupported column type.');
}
function aggregateQuery(columns,parameterNames){
 const ordered=Object.values(columns).sort((a,b)=>a.index-b.index);
 if(!ordered.length||new Set(ordered.map(c=>c.name)).size!==ordered.length||!['Branch','OpAmt','BalAmt'].every(name=>ordered.some(c=>c.name===name)))throw fail('Stock valuation result schema is incomplete.');
 if(parameterNames.some(name=>!/^\w+$/.test(name)))throw fail('Invalid stock procedure parameter.');
 // Capture the unchanged report-7 result inside SQL Server. Only branch totals
 // cross the network; no alteration to ERP procedures, prices or movements.
 return `CREATE TABLE #IncomeStockRows (${ordered.map(c=>quote(c.name)+' '+columnType(c)+' NULL').join(',')});
 INSERT INTO #IncomeStockRows EXEC dbo.POSStockMovement ${parameterNames.map(name=>'@'+name+'=@'+name).join(',')};
 SELECT Branch, SUM(OpAmt) AS OpAmt,SUM(BalAmt) AS BalAmt,COUNT_BIG(*) AS SourceRows,
 SUM(CASE WHEN OpAmt IS NULL OR BalAmt IS NULL THEN 1 ELSE 0 END) AS InvalidAmounts
 FROM #IncomeStockRows GROUP BY Branch;
 DROP TABLE #IncomeStockRows;`;
}
function aggregateRows(rows,branchCodes){
 const permitted=new Set(branchCodes),totals=new Map();
 for(const row of rows){const code=String(row.Branch??'').trim();if(!permitted.has(code)||totals.has(code))throw fail('Stock returned an unexpected branch.');
  if(Number(row.InvalidAmounts)!==0||Number(row.SourceRows)<1||row.OpAmt==null||row.BalAmt==null||!Number.isFinite(Number(row.OpAmt))||!Number.isFinite(Number(row.BalAmt)))throw fail('Stock valuation contains incomplete amounts.');
  totals.set(code,{openingInventory:Math.round(Number(row.OpAmt)*100)/100,closingInventory:Math.round(Number(row.BalAmt)*100)/100});
 }
 return totals;
}
async function stockValuation(transaction,input){
 const deadline=Date.now()+(input.timeoutMs??240000);
 async function run(request,action){const remaining=deadline-Date.now();if(remaining<=0)throw timedOut();request.timeout=remaining;let expired=false;const timer=setTimeout(()=>{expired=true;request.cancel();},remaining);try{return await action();}catch(error){if(expired)throw timedOut();throw error;}finally{clearTimeout(timer);}}
 const definitionRequest=new sql.Request(transaction);
 const definition=await run(definitionRequest,()=>definitionRequest.query("SELECT definition,uses_ansi_nulls,uses_quoted_identifier,SCHEMA_NAME() AS callerSchema,CAST(SESSIONPROPERTY('ANSI_NULLS') AS int) AS sessionAnsiNulls,CAST(SESSIONPROPERTY('QUOTED_IDENTIFIER') AS int) AS sessionQuotedIdentifier FROM sys.sql_modules WHERE object_id=OBJECT_ID('dbo.POSStockMovement')"));
 const metadata=definition.recordset?.[0];
 const projected=projectionForMetadata(metadata);
 if(projected){
  const request=stockRequest(transaction,input);
  const result=await run(request,()=>request.query(projected));
  return aggregateRows(result.recordset||[],input.branchCodes);
 }
 // A zero-match probe obtains the exact tenant-specific result schema, avoiding
 // a fragile hard-coded 60-column INSERT EXEC contract or stale schema cache.
 const probe=stockRequest(transaction,input,','+crypto.randomUUID()+',');let columns,multipleSets=false;
 probe.on('recordset',value=>{if(columns)multipleSets=true;else columns=value;});
 await run(probe,()=>streamRows(probe,()=>probe.execute('dbo.POSStockMovement'),async rows=>{if(rows.length)throw fail('Stock schema probe unexpectedly returned product data.');}));
 if(multipleSets)throw fail('Stock procedure returned multiple result sets.');
 const request=stockRequest(transaction,input);const query=aggregateQuery(columns||{},Object.keys(request.parameters));
 const result=await run(request,()=>request.query(query));
 return aggregateRows(result.recordset||[],input.branchCodes);
}
module.exports={stockValuation,stockRequest,aggregateQuery,aggregateRows,columnType};
