const {DatabaseSync}=require('node:sqlite');
const resources=require('../services/knowledgeResourceService');
const intelligence=require('../services/intelligenceService');
const {closeAllPools}=require('../config/db');
const quote=value=>'"'+value.replaceAll('"','""')+'"';
(async()=>{
  const manifest=await resources.getManifest({tenantId:'tenant_1',companyCode:'TT',isAdmin:true,allowedBranches:[]});
  const schema=manifest.resources.filter(table=>table.objectType!=='UNAVAILABLE').map(table=>({name:table.name,columns:table.columns.map(column=>column.name)}));
  const db=new DatabaseSync(':memory:');
  for(const table of manifest.resources.filter(table=>table.objectType!=='UNAVAILABLE'))db.exec(`CREATE TABLE ${quote(table.name)} (${table.columns.map(column=>`${quote(column.name)} ${/int|decimal|numeric|money|float|real/i.test(column.dataType)?'REAL':'TEXT'}`).join(',')})`);
  const code=process.argv[2]||'RPT_02_001_SALES_SUMMARY';
  const result=await intelligence.createReportPlan({code,schema,filters:{fromDate:'2026-09-01',toDate:'2026-09-28',branches:[],accounts:[],stores:[],products:{}},language:'Roman Urdu',permissions:{isAdmin:true,branches:[]}});
  for(const query of result.plan.queries){try{const rows=db.prepare(query.sql).all();console.log(JSON.stringify({id:query.id,rows:rows.length,columns:Object.keys(rows[0]||{})}));}catch(error){console.error(query.sql);throw error;}}
  db.close();
  console.log('PASS: live schema report plan compiles and executes against SQLite empty-data fixture.');
})().catch(error=>{console.error(error.message);process.exitCode=1}).finally(closeAllPools);
