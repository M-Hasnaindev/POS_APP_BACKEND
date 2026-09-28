const { getPoolForTenant } = require('../config/db');
const { getManifest } = require('./knowledgeResourceService');
const { getBranchPriceAccess } = require('./branchPriceAccessService');
const { getReport } = require('./businessCatalogService');
const { compileReport } = require('./deterministicReportCompiler');

function cleanFilters(input={}) {
  const fromDate=String(input.fromDate||''),toDate=String(input.toDate||'');
  const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
  if(!valid(fromDate)||!valid(toDate)||fromDate>toDate||Date.parse(toDate)-Date.parse(fromDate)>366*86400000)throw Object.assign(new Error('Live reports require a valid date range of at most 367 days'),{status:400});
  const list=value=>Array.isArray(value)?[...new Set(value.map(String))].slice(0,100):[];
  const products=Object.fromEntries(Object.entries(input.products||{}).filter(([,value])=>String(value).trim()).slice(0,30).map(([key,value])=>[key,String(value).slice(0,200)]));
  return {fromDate,toDate,branches:list(input.branches),stores:list(input.stores),accounts:list(input.accounts),products};
}

async function runLiveReport(user,body={}) {
  if(!user?.companyCode)throw Object.assign(new Error('Authenticated company is required for live reports'),{status:403});
  const report=getReport(body.code),filters=cleanFilters(body.filters);
  const access=await getBranchPriceAccess({tenantId:user.tenantId,userId:user.userId,companyCode:user.companyCode});
  const permissions={isAdmin:access.isAdmin,companyCode:user.companyCode,branches:access.branches.map(branch=>branch.BranchCode).filter(Boolean)};
  const manifest=await getManifest({tenantId:user.tenantId,companyCode:user.companyCode,isAdmin:access.isAdmin,allowedBranches:permissions.branches});
  const schema=manifest.resources.filter(table=>table.objectType!=='UNAVAILABLE'&&table.schema==='dbo').map(table=>({name:table.name,columns:table.columns.map(column=>column.name)}));
  // Neither client SQL, client schema, nor LLM SQL is accepted by this route.
  const compiled=compileReport(report,schema,filters,permissions,{dialect:'mssql'});
  if(!compiled)throw Object.assign(new Error('This report does not yet support secure live fallback. Sync Business Resources to use its local report.'),{status:422});
  const pool=await getPoolForTenant(user.tenantId);
  const request=pool.request();request.timeout=45000;
  const capturedAt=new Date().toISOString();
  const result=await request.query(compiled.executionBatch);
  if(result.recordsets?.length!==3)throw new Error('Live report returned an incomplete result');
  const evidence=compiled.queries.map((query,index)=>({id:query.id,purpose:query.purpose,rows:result.recordsets[index]}));
  const totals=evidence[0].rows[0],check=evidence[2].rows[0];
  if(evidence[0].rows.length!==1||evidence[2].rows.length!==1)throw new Error('Live totals are incomplete');
  for(const key of Object.keys(totals)){
    if(totals[key]===null||check[key]===null){
      if(totals[key]!==check[key])throw new Error('Live unavailable metrics failed reconciliation');
      continue;
    }
    const a=Number(totals[key]),b=Number(check[key]);
    if(!Number.isFinite(a)||!Number.isFinite(b)||Math.abs(a-b)>Math.max(.01,Math.abs(a)*1e-10))throw new Error('Live totals failed reconciliation');
  }
  const {executionBatch,...plan}=compiled;
  // Do not expose executable SQL as a reusable client capability.
  plan.queries=plan.queries.map(({id,purpose})=>({id,purpose,sql:''}));
  return {report,filters,plan,evidence,source:'live',sourceTimestamp:capturedAt,validation:{queryCount:3,rowCount:evidence.reduce((sum,item)=>sum+item.rows.length,0),numericCells:evidence.flatMap(item=>item.rows).reduce((sum,row)=>sum+Object.values(row).filter(value=>typeof value==='number').length,0),emptyQueries:evidence.filter(item=>!item.rows.length).map(item=>item.id),validatedAt:new Date().toISOString()}};
}
module.exports={runLiveReport,cleanFilters};
