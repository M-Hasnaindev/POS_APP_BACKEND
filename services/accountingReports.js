const { sql } = require('../config/db');
const { getBranchPriceAccess } = require('./branchPriceAccessService');

const modes = Object.freeze({
  'accounting-ledger':'L','trial-balance':'T','trial-balance-six-column':'T',
  'account-movement':'M','income-statement':'I','balance-sheet':'B','audit-trial':'A',
  'month-wise-account':'MWR','month-wise-expense':'MWR','month-wise-cash-bank':'MWR',
  'daily-cash-bank-flow':'DAILYCASH','party-wise-collection':'PWC','party-wise-payment':'PWP',
  'post-dated-cheques':'PCHQLST','receivable-aging':'BILLWISE','payable-aging':'BILLWISE',
  'cash-bank-position':'T','chart-of-accounts':null,
});
const bad = message => Object.assign(new Error(message), {statusCode:422});
function field(row, names) {
  for (const name of names) { const key=Object.keys(row).find(k=>k.toLowerCase()===name.toLowerCase()); if(key && row[key]!=null)return String(row[key]).trim(); }
  return '';
}
async function metadata(pool, context) {
  const [access, result] = await Promise.all([
    getBranchPriceAccess({...context,pool}), pool.request().query('SELECT * FROM AccountList'),
  ]);
  const schema=await pool.request().query("SELECT name FROM sys.parameters WHERE object_id=OBJECT_ID('AccProc') ORDER BY parameter_id; SELECT name FROM sys.parameters WHERE object_id=OBJECT_ID('BillBalance') ORDER BY parameter_id;");
  const expected=['@Acccount','@dtFrom','@dtTo','@ReportType','@EntryType','@CurrentUserId','@AuditTrailUser','@DifferenceStatus','@TrialBalanceLevel','@ZeroBalanceLedgers','@GetAdjustments','@VoucherFrom','@VoucherTo','@OpEntry','@CompanyCode','@CancelVoucher','@BranchCode','@Consol','@LedgerType'];
  const matches=(rows,names)=>rows?.length===names.length&&rows.every((row,index)=>row.name.toLowerCase()===names[index].toLowerCase());
  if(!matches(schema.recordsets?.[0],expected))throw bad('This company has a different accounting procedure contract. Report setup requires verification.');
  const agingSupported=matches(schema.recordsets?.[1],['@CompanyCode','@Acccount','@DateTo','@RecLinkNo','@ReportType','@BillStatus','@GetType','@PartyType','@Branchcode','@Unitcode']);
  const raw=result.recordset || [];
  const seen=new Set();
  const accounts=raw.map(row=>({code:field(row,['ACCODE','ActCod','AccountCode','ACCode','Code']),name:field(row,['ACNAME','ActNam','ActName','AccountName','Name']),nature:field(row,['ACNATURE','AccountNature']),raw:row}))
    .filter(row=>row.code && !seen.has(row.code) && seen.add(row.code));
  return {accounts,agingSupported,branches:access.branches.map(b=>({code:b.BranchCode,name:b.BranchName||b.BranchCode}))};
}
function validateFilters(input, meta) {
  const list=(key,allowed)=>{
    const value=input[key] ?? [];
    if(!Array.isArray(value)||value.length>2000||value.some(v=>typeof v!=='string'||v.length>100||/[,'"\r\n;]/.test(v)))throw bad(`Invalid ${key} selection`);
    const selected=[...new Set(value)];
    if(selected.some(code=>!allowed.has(code)))throw Object.assign(new Error(`Unauthorized ${key} selection`),{statusCode:403});
    return selected;
  };
  const branchCodes=list('branchCodes',new Set(meta.branches.map(b=>b.code)));
  if(!meta.branches.length)throw Object.assign(new Error('No permitted branches are available'),{statusCode:403});
  const accountCodes=list('accountCodes',new Set(meta.accounts.map(a=>a.code)));
  const choice=(key,values,fallback)=>{const value=input[key]??fallback;if(!values.includes(value))throw bad(`Invalid ${key}`);return value;};
  return {branchCodes:branchCodes.length?branchCodes:meta.branches.map(b=>b.code),accountCodes,
    reporting:choice('reporting',['B','C'],'C'),dateBasis:choice('dateBasis',['V','C','D'],'V'),
    includeOpening:choice('includeOpening',['Y','N'],'Y'),includeAdjustments:choice('includeAdjustments',['Y','N'],'Y'),
    includeCancelled:choice('includeCancelled',['Y','N'],'N'),reportLevel:choice('reportLevel',['0','1','2','3','4','5','6','7'],'0'),
    view:choice('view',['summary','detail'],'summary'),billStatus:choice('billStatus',['A','C','O','D','U'],'A'),
    havingNoTransaction:choice('havingNoTransaction',['Y','N'],'N'),
    voucherType:choice('voucherType',['AL','CB','BB','JV','SV','PV','DN','CN','ODN','OCN','AD'],'AL'),
    auditStatus:choice('auditStatus',['ALL','EQUAL','NEQUAL'],'ALL')};
}
function validDate(value) {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
}
async function runReport(pool, context, reportType, input, meta) {
  if(!Object.hasOwn(modes,reportType))throw bad('Unsupported accounting report');
  if(reportType==='balance-sheet')throw bad('Balance Sheet requires verified equity account mapping. The cash/bank procedure is not a balance sheet.');
  if(reportType==='post-dated-cheques')throw bad('Post-dated Cheques requires a company- and branch-scoped query before it can be enabled.');
  const filters=validateFilters(input,meta);
  if(!validDate(input.fromDate)||!validDate(input.toDate)||input.fromDate>input.toDate)throw bad('Select a valid date range');
  if(reportType==='chart-of-accounts')return {data:meta.accounts.filter(a=>!filters.accountCodes.length||filters.accountCodes.includes(a.code)).map(a=>a.raw),filters};
  const isAging=['receivable-aging','payable-aging'].includes(reportType);
  if(isAging&&!meta.agingSupported)throw bad('Bill aging is not supported by this company database.');
  if(['month-wise-account','month-wise-expense','month-wise-cash-bank'].includes(reportType)){
    const monthSpan=(Number(input.toDate.slice(0,4))-Number(input.fromDate.slice(0,4)))*12+Number(input.toDate.slice(5,7))-Number(input.fromDate.slice(5,7));
    if(monthSpan>11)throw bad('Monthly reports support up to 12 calendar months. Please shorten the range.');
  }
  if(['income-statement','month-wise-expense','month-wise-cash-bank','cash-bank-position'].includes(reportType)){
    const eligible=meta.accounts.filter(a=>reportType==='income-statement'?['3','4','5'].includes(a.nature):reportType==='month-wise-expense'?a.nature==='5':['CB','BB'].includes(field(a.raw,['BookType','DetBookType','CFAccountType']).toUpperCase())).map(a=>a.code);
    if(filters.accountCodes.some(code=>!eligible.includes(code)))throw bad('Select accounts matching this report category.');
    if(!filters.accountCodes.length)filters.accountCodes=eligible;
    if(!filters.accountCodes.length)return {data:[],filters,procedureReportType:modes[reportType]};
  }
  const request=pool.request();request.timeout=240000;
  const wrapped=values=>values.length?`,${values.join(',')},`:'';
  if(isAging){
    const params={company:context.companyCode,accounts:wrapped(filters.accountCodes),toDate:input.toDate,mode:filters.view==='detail'?'BILLWISE':'PARTYWISE',status:filters.billStatus,party:reportType==='receivable-aging'?'C':'S',branches:wrapped(filters.branchCodes)};
    for(const [key,value] of Object.entries(params))request.input(key,sql.NVarChar(sql.MAX),value);
    const result=await request.query("EXEC BillBalance @company,@accounts,@toDate,'',@mode,@status,'ALL',@party,@branches,''");
    return {data:result.recordset||[],filters,procedureReportType:params.mode,asOf:true};
  }
  const mode=filters.view==='detail'&&reportType==='party-wise-collection'?'PWCD':filters.view==='detail'&&reportType==='party-wise-payment'?'PWPD':modes[reportType];
  const params={accounts:wrapped(filters.accountCodes),fromDate:input.fromDate,toDate:input.toDate,mode,
    format:reportType==='audit-trial'?filters.voucherType:'AL',userId:context.userId,
    selection:reportType==='audit-trial'?filters.auditStatus:'ALL',opening:filters.includeOpening,adjustments:filters.includeAdjustments,
    zeroBalance:filters.havingNoTransaction,company:context.companyCode,cancelled:filters.includeCancelled,level:filters.reportLevel,
    branches:wrapped(filters.branchCodes),reporting:filters.reporting,dateBasis:filters.dateBasis};
  for(const [key,value] of Object.entries(params))request.input(key,sql.NVarChar(sql.MAX),value);
  const result=await request.query(`EXEC AccProc @accounts,@fromDate,@toDate,@mode,@format,@userId,'',@selection,@level,@zeroBalance,@adjustments,'00000000000000','zzzzzzzzzzzzzz',@opening,@company,@cancelled,@branches,@reporting,@dateBasis`);
  return {data:result.recordset||[],filters,procedureReportType:mode};
}
module.exports={metadata,validateFilters,validDate,runReport,modes};
