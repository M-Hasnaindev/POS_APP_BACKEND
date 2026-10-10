const { sql } = require('../config/db');
const { getBranchPriceAccess } = require('./branchPriceAccessService');
const fail = message => Object.assign(new Error(message), {statusCode:422});
const quote = name => '[' + name.replace(/]/g, ']]') + ']';
const allowed = new Set(('CompanyCode CompanyID BranchCode BranchID BranchName BranchDescription ShortName Code ID Name Description ActCod ActNam ActName AccountCode AccountID AccountName AccountDescription ACCode ACName AcNature AccountNature AccountNatureCode NatureCode NatureID NatureId Nature DetNatureCode DetNatureID DetNatureId DetNature AccountType Type BookType Book PartyType Parent ParentCode ParentName ParentActCod ParentActName ParentAccountCode ParentAccountName ParentBranchCode ParentBranchName Level IsDetail Detail ACLevel BranchType UnitCode UnitName').toLowerCase().split(' '));
for(const field of ['BranchTitle','Branch','AccountTitle','ParentID','MainCode','GroupCode','ParentTitle','ActType','AcType','A/C Type','AccType','Typ','NatureName','DetNatureName','ACTypeName','AccountTypeName','TypeName','Book Type','cBookType','ShortBookType','CFAccountType','DetBookType','DetBook Type','BookTypeCode','DetBooktypeCode','cPartytype','ShortPartyType','PartyTypeCode','DetPartytypeCode'])allowed.add(field.toLowerCase());
function lookupPlan(table, columns, companyCode) {
  if(!['BranchList','AccountList'].includes(table))throw fail('Unsupported lookup source');
  const names = columns.map(row => row.name);
  const find = choices => choices.map(c => names.find(n => n.toLowerCase() === c.toLowerCase())).find(Boolean);
  const company = find(['CompanyCode','CompanyID']);
  const code = find(table === 'BranchList' ? ['BranchCode','BranchID','Code','ID'] : ['ActCod','AccountCode','ACCode','Code','ID']);
  if (!code) throw fail(`${table} is missing its account/branch identifier`);
  const where = company ? [`LTRIM(RTRIM(${quote(company)}))=@companyCode`] : [];
  if (table === 'AccountList') where.push(`${quote(code)} <> '0'`);
  const selected = names.filter(n => allowed.has(n.toLowerCase()));
  const query = `SELECT ${selected.map(quote).join(', ')} FROM ${quote(table)}${where.length ? ' WHERE '+where.join(' AND ') : ''} ORDER BY ${quote(code)}`;
  return {query, code, companyScoped:Boolean(company), companyCode};
}
async function loadAccountingFilterOptions(pool, context) {
  const [schema,access] = await Promise.all([
    pool.request().query("SELECT OBJECT_NAME(object_id) AS tableName, name FROM sys.columns WHERE object_id IN (OBJECT_ID('BranchList'),OBJECT_ID('AccountList'),OBJECT_ID('Chart'))"),
    getBranchPriceAccess({...context,pool}),
  ]);
  const columns = table => (schema.recordset||[]).filter(row => String(row.tableName).toLowerCase() === table.toLowerCase());
  const plans = ['BranchList','AccountList'].map(table => lookupPlan(table,columns(table),context.companyCode));
  const rows = await Promise.all(plans.map(plan => pool.request().input('companyCode',sql.VarChar(50),context.companyCode).query(plan.query)));
  const permitted = new Set(access.branches.map(branch => String(branch.BranchCode).trim()));
  const branches = (rows[0].recordset||[]).filter(row => permitted.has(String(row[plans[0].code]||'').trim()));
  const chartColumns=columns('Chart');
  const actCod=chartColumns.find(row => row.name.toLowerCase()==='actcod');
  const company=chartColumns.find(row => ['companycode','companyid'].includes(row.name.toLowerCase()));
  let levels=[{Row:0,Level:'Detail'}];
  const warnings=[];
  if(actCod){
    const query=`SELECT 0 AS Row,'Detail' AS Level UNION ALL SELECT ROW_NUMBER() OVER(ORDER BY LEN(${quote(actCod.name)})) AS Row, 'Level '+CAST(ROW_NUMBER() OVER(ORDER BY LEN(${quote(actCod.name)})) AS VARCHAR(10)) AS Level FROM [Chart] ${company?'WHERE LTRIM(RTRIM('+quote(company.name)+'))=@companyCode':''} GROUP BY LEN(${quote(actCod.name)}) ORDER BY Row`;
    const result=await pool.request().input('companyCode',sql.VarChar(50),context.companyCode).query(query);
    levels=result.recordset||levels;
    // Finance hides the terminal detail-code length, retaining its explicit Detail option.
    if(levels.length>1)levels=levels.slice(0,-1);
  }else warnings.push('Account report levels are unavailable; Detail is the only option.');
  return {branches,accounts:rows[1].recordset||[],levels,warnings,lookupScope:{branches:plans[0].companyScoped?'company':'tenant',accounts:plans[1].companyScoped?'company':'tenant',levels:company?'company':'tenant'}};
}
module.exports={loadAccountingFilterOptions,lookupPlan};
