const {sql}=require('../config/db');
const {resolveCompanyStartDate}=require('./accountingService');
const {loadAccountingFilterOptions}=require('./accountingFilterOptions');
const error=(message,statusCode=422,code='INVALID_REPORT_FILTER')=>Object.assign(new Error(message),{statusCode,code});
const TYPES={'accounting-ledger':'L','trial-balance':'T','trial-balance-six-column':'T','account-movement':'M','audit-trial':'A','month-wise-account':'MWR','month-wise-expense':'MWR','month-wise-cash-bank':'MWR','daily-cash-bank-flow':'DAILYCASH','party-wise-collection':'PWC','party-wise-payment':'PWP','receivable-aging':'BILLWISE','payable-aging':'BILLWISE','chart-of-accounts':'COA','cash-bank-position':'B'};
const UNVERIFIED=['income-statement','balance-sheet','post-dated-cheques'];
const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
function field(row,keys){for(const key of keys){const found=Object.keys(row).find(k=>norm(k)===norm(key));if(found&&row[found]!=null&&String(row[found]).trim())return String(row[found]).trim();}return '';}
const accountCode=r=>field(r,['ActCod','AccountCode','ACCode','Code','ID']);
const branchCode=r=>field(r,['BranchCode','BranchID','Code','ID']);
function date(value,name){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw error(`Invalid ${name}`);return value;}
function codes(value,name){if(value===undefined)return [];if(!Array.isArray(value)||value.length>10000||value.some(v=>typeof v!=='string'||!v.trim()||v.length>100||/[,\x00-\x1f]/.test(v)))throw error(`Invalid ${name}`);return [...new Set(value.map(v=>v.trim()))];}
const wrap=values=>values.length?','+values.join(',')+',':'';
function choice(f,key,values,fallback){const v=f[key]===undefined?fallback:f[key];if(typeof v!=='string'||!values.includes(v))throw error(`Invalid ${key}`);return v;}
function yn(f,key,fallback=false){const v=f[key]===undefined?fallback:f[key];if(typeof v!=='boolean')throw error(`Invalid ${key}`);return v?'Y':'N';}
function checkReport(id){if(UNVERIFIED.includes(id))throw error('This report needs its Finance procedure mapping verified before it can be generated.',422,'REPORT_NOT_CONFIGURED');if(!Object.hasOwn(TYPES,id))throw error('Unknown accounting report');}
function buildReportPlan(id,f,companyCode,options){
 checkReport(id);if(!f||typeof f!=='object'||Array.isArray(f))throw error('Invalid report filters');
 if(id==='chart-of-accounts')return {procedure:null,reportType:'COA',rows:options.accounts};
 const permitted=new Set(options.branches.map(branchCode).filter(Boolean));
 let branches=codes(f.branchCodes,'branches');if(branches.some(c=>!permitted.has(c)))throw error('A selected branch is not available to your account.',403,'BRANCH_ACCESS_DENIED');if(!branches.length)branches=[...permitted];if(!branches.length)throw error('No authorized branches are available.',403,'BRANCH_ACCESS_DENIED');
 let accounts=codes(f.accountCodes,'accounts');const accountSet=new Set(options.accounts.map(accountCode));if(accounts.some(c=>!accountSet.has(c)))throw error('A selected account is unavailable. Reload the report filters.');
 if(['month-wise-expense','month-wise-cash-bank','daily-cash-bank-flow'].includes(id)){
 const subset=options.accounts.filter(r=>id==='month-wise-expense'?[field(r,['AcNature','AccountNature','AccountNatureCode','NatureCode','NatureID','Nature','DetNatureCode','DetNatureID','DetNature']),field(r,['NatureName','Nature','DetNatureName','DetNature','ACTypeName','ACType','AccountTypeName','AccountType','TypeName','Type'])].some(v=>['5','expense','expenses'].includes(v.toLowerCase())):['cb','bb','cashbook','bankbook'].includes(norm(field(r,['BookType','cBookType','ShortBookType','CFAccountType','DetBooktype','BookTypeCode','DetBooktypeCode','Book']))));
 const set=new Set(subset.map(accountCode));if(accounts.some(c=>!set.has(c)))throw error('Selected accounts do not match this report category.');
 if(!accounts.length&&id!=='month-wise-cash-bank'){accounts=[...set];if(!accounts.length)throw error('No matching accounts are available for this report.');}
 }
 if(id==='cash-bank-position'&&choice(f,'view',['summary','detail'],'summary')==='detail')throw error('Cash & bank detail procedure mapping is not verified. Choose Summary.',422,'REPORT_NOT_CONFIGURED');
 const aging=id.endsWith('-aging');
 if(aging){const reportType=choice(f,'agingView',['bill-wise','party-wise'],'bill-wise')==='bill-wise'?'BILLWISE':'PARTYWISE';return {procedure:'BillBalance',reportType,params:[companyCode,wrap(accounts),date(f.asOnDate,'as-on date'),'',reportType,choice(f,'billType',['A','C','O','D','U'],'A'),'ALL',choice(f,'partyType',['C','S','B'],id==='receivable-aging'?'C':'S'),wrap(branches),'']};}
 const from=date(id==='cash-bank-position'?options.companyStart:f.fromDate,'from date'),to=date(id==='cash-bank-position'?f.asOnDate:f.toDate,'to date');if(from>to)throw error('From date must be before or equal to To date.');
 const audit=id==='audit-trial',daily=id==='daily-cash-bank-flow',party=id.startsWith('party-wise-'),cash=id==='cash-bank-position',month=id.startsWith('month-wise-');
 const reportType=TYPES[id]+(party&&choice(f,'view',['summary','detail'],'summary')==='detail'?'D':'');
 const levelReports=['trial-balance','trial-balance-six-column','account-movement','month-wise-account','month-wise-expense','month-wise-cash-bank'];
 const level=levelReports.includes(id)?choice(f,'reportLevel',options.levels.map(r=>String(r.Row)),'0'):'0';
 return {procedure:'AccProc',reportType,params:[audit?'':wrap(accounts),from,to,reportType,audit?choice(f,'voucherType',['AL','CB','BB','JV','SV','PV','DN','CN','ODN','OCN','AD'],'AL'):'AL','Cherrys',audit||daily||party||cash||month||id==='account-movement'?'YES':'',audit?choice(f,'auditStatus',['ALL','NEQUAL','EQUAL'],'ALL'):'ALL',level,audit||daily||party||cash?'Y':yn(f,'includeOpening',true),audit?'Y':daily||cash?'N':yn(f,'includePdc'),'00000000000000','zzzzzzzzzzzz',audit||daily||party||cash?'Y':yn(f,'havingNoTransaction',true),companyCode,cash?'N':yn(f,'includeClosingAdjustment'),wrap(branches),daily?'C':choice(f,'reporting',['B','C'],'C'),id==='accounting-ledger'?choice(f,'dateBasis',['V','C','D'],'V'):'V']};
}
async function executeAccountingReport(pool,context,id,filters){
 checkReport(id);
 const options=await loadAccountingFilterOptions(pool,context);
 if(id==='cash-bank-position')options.companyStart=await resolveCompanyStartDate(pool,context.companyCode);
 const plan=buildReportPlan(id,filters,context.companyCode,options);
 let rows=plan.rows;
 const columnMappings={branches:[],accounts:[]};
 if(plan.procedure){
  // AccProc writes shared working tables; return its rows but roll back all working-table changes.
  // Serialize POS executions per database. Finance callers do not acquire this application lock.
  if(plan.procedure==='AccProc')plan.params[5]=context.userId;
  const transaction=new sql.Transaction(pool);let begun=false;
  try{
   await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);begun=true;
   await new sql.Request(transaction).query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource='POSAccountingReports',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000; IF @r<0 THROW 51000,'Report is busy. Retry shortly.',1;");
   if(plan.procedure==='AccProc')await new sql.Request(transaction).input('userId',sql.NVarChar(100),context.userId).query("IF OBJECT_ID('TmpStores') IS NOT NULL DELETE FROM TmpStores WHERE UserID=@userId; IF OBJECT_ID('Tmp_Branch') IS NOT NULL DELETE FROM Tmp_Branch WHERE UserID=@userId;");
   const request=new sql.Request(transaction);plan.params.forEach((value,index)=>request.input('p'+index,sql.NVarChar(sql.MAX),value));request.timeout=80000;
   const result=await request.query('EXEC '+plan.procedure+' '+plan.params.map((_,i)=>'@p'+i).join(', '));rows=result.recordset||[];
   if(plan.procedure==='AccProc'){
    const mappings=await new sql.Request(transaction).input('userId',sql.NVarChar(100),context.userId).input('company',sql.NVarChar(50),context.companyCode).query("IF OBJECT_ID('Tmp_Branch') IS NOT NULL SELECT [Row],BranchCode,BranchName FROM Tmp_Branch WHERE UserID=@userId ORDER BY [Row]; ELSE SELECT 1 WHERE 1=0; IF OBJECT_ID('TmpStores') IS NOT NULL SELECT [Row],StoreCode,StoreName FROM TmpStores WHERE UserID=@userId AND CompanyCode=@company ORDER BY [Row]; ELSE SELECT 1 WHERE 1=0;");
    columnMappings.branches=mappings.recordsets?.[0]||[];columnMappings.accounts=mappings.recordsets?.[1]||[];
   }
   await transaction.rollback();begun=false;
  }catch(err){if(begun)await transaction.rollback().catch(()=>undefined);throw err;}
 }

 return {rows,columnMappings,reportId:id,procedure:plan.procedure,reportType:plan.reportType,companyCode:context.companyCode,generatedAt:new Date().toISOString()};
}
module.exports={buildReportPlan,executeAccountingReport,TYPES,UNVERIFIED};
