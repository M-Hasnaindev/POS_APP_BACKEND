const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const store=require('../services/resourceDeltaStore');
const {sql,closeAllPools}=require('../config/db');
const {getTenantById}=require('../config/tenants');

(async()=>{
  const context={tenantId:`test-${crypto.randomUUID()}`,companyCode:'fixture',allowedBranches:[],isAdmin:true,table:{name:'fixture',columns:[{name:'id'},{name:'value'}]},schemaHash:'fixture'};
  let rows=[{id:1,value:'old'},{id:2,value:'duplicate'},{id:2,value:'duplicate'},{id:3,value:null}];
  let fingerprint='first';
  const read=async()=>({rows,hasMore:false});
  const first=await store.step(context,read,async()=>fingerprint);
  assert.equal(first.building,false);
  const full=await store.changes(context,first.version,null);
  assert.equal(full.rows.reduce((sum,row)=>sum+row.copies,0),4);
  assert.equal(full.rows.find(row=>row.values[0]===2).copies,2);
  const config=getTenantById('tenant_1').config;
  const db=await new sql.ConnectionPool({...config,database:process.env.RESOURCE_SYNC_DATABASE}).connect();
  try{
    await db.request().input('id',sql.UniqueIdentifier,first.version).query('UPDATE dbo.ResourceSnapshot SET CompletedAt=DATEADD(minute,-2,SYSUTCDATETIME()) WHERE Id=@id');
    rows=[{id:1,value:'updated'},{id:2,value:'duplicate'},{id:4,value:'added'}];fingerprint='second';
    const second=await store.step(context,read,async()=>fingerprint);
    const delta=await store.changes(context,second.version,first.version);
    assert.ok(delta.rows.some(row=>row.values[0]===3&&row.copies===0));
    assert.ok(delta.rows.some(row=>row.values[0]===2&&row.previousCopies===2&&row.copies===1));
    assert.ok(delta.rows.some(row=>row.values[1]==='old'&&row.copies===0));
    assert.ok(delta.rows.some(row=>row.values[1]==='updated'&&row.copies===1));
    await assert.rejects(()=>store.changes({...context,companyCode:'other'},second.version,null));
    const same=await store.step(context,read,async()=>fingerprint);
    assert.equal(same.version,second.version);
    assert.equal((await store.changes(context,second.version,second.version)).rows.length,0);
    console.log('PASS: separate-store initial snapshot, updates, deletes, duplicate counts, unchanged sync, tenant isolation.');
  }finally{
    await db.request().input('scope',sql.Char(64),store.scopeKey(context)).query('DELETE r FROM dbo.ResourceSnapshotRow r JOIN dbo.ResourceSnapshot s ON s.Id=r.SnapshotId WHERE s.ScopeKey=@scope; DELETE dbo.ResourceSnapshot WHERE ScopeKey=@scope');
    await db.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{await store.close();await closeAllPools()});
