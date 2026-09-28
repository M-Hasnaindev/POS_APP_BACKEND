const { sql, getPoolForTenant, closeAllPools } = require('../config/db');
const store = require('../services/resourceDeltaStore');

(async () => {
  const name=process.env.RESOURCE_SYNC_DATABASE;
  if(!name || !/^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(name))throw new Error('Set RESOURCE_SYNC_DATABASE to a separate database name');
  const tenants=require('../config/tenants').tenants;
  if(tenants.some(tenant=>tenant.config.database.toLowerCase()===name.toLowerCase()))throw new Error('Cannot use a POS database as the sync store');
  const source=await getPoolForTenant(process.env.RESOURCE_SYNC_TENANT||'tenant_1');
  const exists=await source.request().input('name',sql.NVarChar(128),name).query('SELECT database_id FROM sys.databases WHERE name=@name');
  if(!exists.recordset.length)await source.request().query(`CREATE DATABASE [${name}]`);
  await store.initialize();
  console.log('Separate resource sync store initialized; POS tables unchanged.');
})().catch(error=>{console.error(error.message);process.exitCode=1}).finally(async()=>{await store.close();await closeAllPools()});
