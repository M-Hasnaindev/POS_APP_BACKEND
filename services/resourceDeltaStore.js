const crypto = require("crypto");
const { sql } = require("../config/db");
const { getTenantById } = require("../config/tenants");

let pendingPool;
function enabled() { return Boolean(process.env.RESOURCE_SYNC_DATABASE); }
async function pool() {
  if (!enabled()) throw Object.assign(new Error("Separate resource sync database is not configured"), { status: 503 });
  if (!pendingPool) {
    const tenant = getTenantById(process.env.RESOURCE_SYNC_TENANT || "tenant_1");
    if (!tenant) throw new Error("Sync store connection tenant is unavailable");
    if (tenant.config.database.toLowerCase() === process.env.RESOURCE_SYNC_DATABASE.toLowerCase()) throw new Error("Sync store must be separate from POS database");
    const connection = new sql.ConnectionPool({ ...tenant.config, database: process.env.RESOURCE_SYNC_DATABASE });
    connection.on('error', error => console.error('[SyncStore] Pool error:', error.code || error.name));
    pendingPool = connection.connect().catch(error => { pendingPool = null; throw error; });
  }
  return pendingPool;
}

// A content identity supports legacy tables/views without primary keys. Copies
// preserve duplicate rows; an update is an old-content removal + new-content add.
function contentRow(row, columns) {
  const values = columns.map(column => row[column.name] ?? null);
  const payload = JSON.stringify(values);
  return { hash: crypto.createHash("sha256").update(payload).digest("hex"), payload };
}
function scopeKey(context) {
  return crypto.createHash("sha256").update(JSON.stringify({ tenant: context.tenantId, company: context.companyCode, branches: [...context.allowedBranches].sort(), admin: context.isAdmin, table: context.table.name, schema: context.schemaHash })).digest("hex");
}

async function initialize() {
  const connection = await pool();
  await connection.request().query(`
    IF OBJECT_ID('dbo.ResourceSnapshot','U') IS NULL
    CREATE TABLE dbo.ResourceSnapshot (
      Id uniqueidentifier NOT NULL PRIMARY KEY, ScopeKey char(64) NOT NULL,
      Status varchar(12) NOT NULL, RowOffset bigint NOT NULL DEFAULT 0,
      CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(), CompletedAt datetime2 NULL,
      StartFingerprint varchar(64) NOT NULL
    );
    IF OBJECT_ID('dbo.ResourceSnapshotRow','U') IS NULL
    CREATE TABLE dbo.ResourceSnapshotRow (
      SnapshotId uniqueidentifier NOT NULL, RowHash char(64) NOT NULL,
      Copies bigint NOT NULL, Payload nvarchar(max) NOT NULL,
      PRIMARY KEY(SnapshotId,RowHash),
      FOREIGN KEY(SnapshotId) REFERENCES dbo.ResourceSnapshot(Id)
    );
    IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE name='IX_ResourceSnapshot_Scope')
    CREATE INDEX IX_ResourceSnapshot_Scope ON dbo.ResourceSnapshot(ScopeKey,CreatedAt DESC);
  `);
}

async function step(context, readPage, fingerprint) {
  const connection = await pool();
  const scope = scopeKey(context);
  const transaction = new sql.Transaction(connection);
  await transaction.begin();
  try {
    const locked = await new sql.Request(transaction).input("scope", sql.VarChar(80), `resource:${scope}`).query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=@scope,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=0; SELECT @r result");
    if (locked.recordset[0].result < 0) { await transaction.rollback(); return { building: true, busy: true }; }
    const current = await new sql.Request(transaction).input("scope",sql.Char(64),scope).query("SELECT TOP(1) * FROM dbo.ResourceSnapshot WHERE ScopeKey=@scope AND Status IN ('building','complete') ORDER BY CreatedAt DESC");
    let snapshot = current.recordset[0];
    if(snapshot)snapshot.Id=String(snapshot.Id).toLowerCase();
    const fresh = snapshot?.Status === "complete" && Date.now() - new Date(snapshot.CompletedAt).getTime() < 60000;
    if (fresh) { await transaction.commit(); return { building:false, version:snapshot.Id, rowCount:Number(snapshot.RowOffset) }; }
    if (!snapshot || snapshot.Status === "complete") {
      const value = await fingerprint();
      snapshot = { Id:crypto.randomUUID(),RowOffset:0,StartFingerprint:value };
      await new sql.Request(transaction).input("id",sql.UniqueIdentifier,snapshot.Id).input("scope",sql.Char(64),scope).input("fingerprint",sql.VarChar(64),value).query("INSERT dbo.ResourceSnapshot(Id,ScopeKey,Status,StartFingerprint) VALUES(@id,@scope,'building',@fingerprint)");
    }
    const page = await readPage(Number(snapshot.RowOffset));
    const grouped = new Map();
    for (const row of page.rows) { const value=contentRow(row,context.table.columns); const entry=grouped.get(value.hash); if(entry)entry.copies++;else grouped.set(value.hash,{...value,copies:1}); }
    const entries=[...grouped.values()];
    for(let offset=0;offset<entries.length;offset+=400){
      const batch=entries.slice(offset,offset+400),request=new sql.Request(transaction).input("id",sql.UniqueIdentifier,snapshot.Id);
      const slots=batch.map((row,index)=>{request.input(`h${index}`,sql.Char(64),row.hash).input(`c${index}`,sql.BigInt,row.copies).input(`p${index}`,sql.NVarChar(sql.MAX),row.payload);return `(@h${index},@c${index},@p${index})`;});
      await request.query(`
      MERGE dbo.ResourceSnapshotRow WITH(HOLDLOCK) AS target
      USING (SELECT @id SnapshotId,* FROM (VALUES ${slots.join(',')}) batch(RowHash,Copies,Payload)) source
      ON target.SnapshotId=source.SnapshotId AND target.RowHash=source.RowHash
      WHEN MATCHED THEN UPDATE SET Copies=target.Copies+source.Copies
      WHEN NOT MATCHED THEN INSERT(SnapshotId,RowHash,Copies,Payload) VALUES(source.SnapshotId,source.RowHash,source.Copies,source.Payload);
    `);
    }
    const offset=Number(snapshot.RowOffset)+page.rows.length;
    if (!page.hasMore && await fingerprint() !== snapshot.StartFingerprint) {
      await new sql.Request(transaction).input("id",sql.UniqueIdentifier,snapshot.Id).query("DELETE dbo.ResourceSnapshotRow WHERE SnapshotId=@id; DELETE dbo.ResourceSnapshot WHERE Id=@id");
      await transaction.commit(); return { building:true,restarted:true };
    }
    if(!page.hasMore){
      const unchanged=await new sql.Request(transaction).input('scope',sql.Char(64),scope).input('id',sql.UniqueIdentifier,snapshot.Id).query(`
        DECLARE @previous uniqueidentifier;
        SELECT TOP(1) @previous=Id FROM dbo.ResourceSnapshot WHERE ScopeKey=@scope AND Status='complete' ORDER BY CreatedAt DESC;
        IF @previous IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM (SELECT RowHash,Copies FROM dbo.ResourceSnapshotRow WHERE SnapshotId=@id) a
          FULL OUTER JOIN (SELECT RowHash,Copies FROM dbo.ResourceSnapshotRow WHERE SnapshotId=@previous) b ON a.RowHash=b.RowHash
          WHERE a.RowHash IS NULL OR b.RowHash IS NULL OR a.Copies<>b.Copies
        ) SELECT @previous Id;
      `);
      const previous=unchanged.recordset?.[0]?.Id;
      if(previous){
        await new sql.Request(transaction).input('id',sql.UniqueIdentifier,snapshot.Id).input('previous',sql.UniqueIdentifier,previous).query('DELETE dbo.ResourceSnapshotRow WHERE SnapshotId=@id;DELETE dbo.ResourceSnapshot WHERE Id=@id;UPDATE dbo.ResourceSnapshot SET CompletedAt=SYSUTCDATETIME() WHERE Id=@previous');
        await transaction.commit();return {building:false,version:String(previous).toLowerCase(),rowCount:offset};
      }
    }
    await new sql.Request(transaction).input("id",sql.UniqueIdentifier,snapshot.Id).input("offset",sql.BigInt,offset).input("status",sql.VarChar(12),page.hasMore?"building":"complete").query("UPDATE dbo.ResourceSnapshot SET RowOffset=@offset,Status=@status,CompletedAt=CASE WHEN @status='complete' THEN SYSUTCDATETIME() ELSE NULL END WHERE Id=@id");
    await transaction.commit();
    return { building:page.hasMore,version:snapshot.Id,rowCount:offset };
  } catch(error) { await transaction.rollback().catch(()=>{}); throw error; }
}

async function changes(context, version, previous, cursor="") {
  if(!/^[a-f0-9-]{36}$/i.test(String(version)) || (previous && !/^[a-f0-9-]{36}$/i.test(String(previous)))) throw Object.assign(new Error("Invalid resource version"),{status:400});
  if(cursor && !/^[a-f0-9]{64}$/i.test(cursor)) throw Object.assign(new Error("Invalid resource cursor"),{status:400});
  const connection=await pool(),scope=scopeKey(context);
  const request=connection.request().input("scope",sql.Char(64),scope).input("version",sql.UniqueIdentifier,version).input("previous",sql.UniqueIdentifier,previous||null).input("cursor",sql.VarChar(64),cursor);
  const result=await request.query(`
    IF NOT EXISTS(SELECT 1 FROM dbo.ResourceSnapshot WHERE Id=@version AND ScopeKey=@scope AND Status='complete') THROW 50001,'Snapshot does not belong to this scope',1;
    IF @previous IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dbo.ResourceSnapshot WHERE Id=@previous AND ScopeKey=@scope AND Status='complete') THROW 50002,'Previous snapshot unavailable; resync required',1;
    WITH beforeRows AS (SELECT RowHash,Copies,Payload FROM dbo.ResourceSnapshotRow WHERE SnapshotId=@previous),
    afterRows AS (SELECT RowHash,Copies,Payload FROM dbo.ResourceSnapshotRow WHERE SnapshotId=@version)
    SELECT TOP(10001) COALESCE(a.RowHash,b.RowHash) hash,COALESCE(a.Copies,0) copies,
      COALESCE(b.Copies,0) previousCopies,COALESCE(a.Payload,b.Payload) payload
    FROM afterRows a FULL OUTER JOIN beforeRows b ON a.RowHash=b.RowHash
    WHERE COALESCE(a.Copies,0)<>COALESCE(b.Copies,0) AND COALESCE(a.RowHash,b.RowHash)>@cursor
    ORDER BY COALESCE(a.RowHash,b.RowHash);
  `);
  let bytes=0;const selected=[];
  for(const row of result.recordset.slice(0,10000)){
    const size=Buffer.byteLength(row.payload,'utf8')+200;
    if(size>3*1024*1024)throw Object.assign(new Error('One resource row exceeds the transport size limit'),{status:413});
    if(selected.length && bytes+size>3*1024*1024)break;
    selected.push(row);bytes+=size;
  }
  const hasMore=result.recordset.length>selected.length;
  const rows=selected.map(row=>({...row,copies:Number(row.copies),previousCopies:Number(row.previousCopies),values:JSON.parse(row.payload),payload:undefined}));
  return {rows,hasMore,nextCursor:rows.at(-1)?.hash||cursor,version,checksum:crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex")};
}

async function close() { const current=pendingPool;pendingPool=null;if(current)await(await current).close(); }
module.exports={enabled,initialize,step,changes,contentRow,scopeKey,close,pool};
