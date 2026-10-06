const crypto = require('crypto');
const { promisify } = require('util');
const { gzip, gunzip } = require('zlib');
const compress = promisify(gzip), decompress = promisify(gunzip);
const { sql } = require('../config/db');
const { pool } = require('./resourceDeltaStore');
const { waitUntil } = require('@vercel/functions');
let initialized;

async function initialize() {
  if (!initialized) initialized = (async () => {
    const db = await pool();
    // This pool is exclusively the existing, separate resource-sync database.
    await db.request().query(`
      SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @lock int;
      EXEC @lock=sys.sp_getapplock @Resource='CherrySyncPageSchema',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=15000;
      IF @lock<0 THROW 50001,'Sync schema is busy',1;
      IF OBJECT_ID('dbo.AppSyncJob','U') IS NULL CREATE TABLE dbo.AppSyncJob(
        Id uniqueidentifier NOT NULL PRIMARY KEY, ScopeKey char(64) NOT NULL,
        TenantId nvarchar(100) NOT NULL, UserId nvarchar(100) NOT NULL,
        Status varchar(16) NOT NULL, Total int NOT NULL DEFAULT 0,
        SourceCount int NOT NULL DEFAULT 0, Error nvarchar(300) NULL,
        Metadata nvarchar(max) NULL, CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
        UpdatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(), ExpiresAt datetime2 NOT NULL);
      IF OBJECT_ID('dbo.AppSyncPage','U') IS NULL CREATE TABLE dbo.AppSyncPage(
        JobId uniqueidentifier NOT NULL, Page int NOT NULL, Payload varbinary(max) NOT NULL,
        PRIMARY KEY(JobId,Page), FOREIGN KEY(JobId) REFERENCES dbo.AppSyncJob(Id) ON DELETE CASCADE);
      IF COL_LENGTH('dbo.AppSyncJob','LeaseUntil') IS NULL ALTER TABLE dbo.AppSyncJob ADD LeaseUntil datetime2 NULL;
      IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID('dbo.AppSyncJob') AND name='IX_AppSyncJob_Scope')
        CREATE INDEX IX_AppSyncJob_Scope ON dbo.AppSyncJob(ScopeKey,CreatedAt DESC);
      COMMIT;
    `);
    return db;
  })().catch(error => { initialized = null; throw error; });
  return initialized;
}

function publicJob(row) {
  return { jobId: String(row.Id).toLowerCase(), status: row.Status, count: row.Total,
    sourceCount: row.SourceCount, generatedAt: row.Status === 'ready' ? new Date(row.UpdatedAt).toISOString() : null,
    error: row.Error || null, metadata: JSON.parse(row.Metadata || '{}') };
}

async function findJob(id, tenantId, userId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const db = await initialize();
  const result = await db.request().input('id', sql.UniqueIdentifier, id)
    .input('tenant', sql.NVarChar(100), tenantId).input('user', sql.NVarChar(100), userId)
    .query(`SELECT * FROM dbo.AppSyncJob WHERE Id=@id AND TenantId=@tenant AND UserId=@user AND ExpiresAt>SYSUTCDATETIME()`);
  const row = result.recordset[0];
  if (!row) return null;
  // ERP procedures may legitimately need several minutes before yielding the
  // first 5,000-row batch. Do not misclassify that quiet preparation window as
  // a failed job; clients poll the durable job and can safely resume it.
  if (row.Status === 'processing' && Date.now() - new Date(row.UpdatedAt).getTime() > 900000) {
    row.Status = 'failed'; row.Error = 'Sync preparation timed out. Please retry.';
    await db.request().input('id', sql.UniqueIdentifier, id).query("UPDATE dbo.AppSyncJob SET Status='failed',Error='Sync preparation timed out. Please retry.' WHERE Id=@id AND Status='processing'");
  }
  return publicJob(row);
}

async function startJob(kind, options, run, reuseReady = false) {
  const db = await initialize();
  const scope = crypto.createHash('sha256').update(JSON.stringify([kind, options])).digest('hex');
  const id = crypto.randomUUID();
  const result = await db.request().input('id', sql.UniqueIdentifier, id).input('scope', sql.Char(64), scope)
    .input('freshSeconds', sql.Int, reuseReady ? 7200 : kind.startsWith('stock') ? 540 : 300)
    .input('tenant', sql.NVarChar(100), options.tenantId).input('user', sql.NVarChar(100), options.userId)
    .query(`SET XACT_ABORT ON; BEGIN TRAN;
      DECLARE @lock int;
      EXEC @lock=sys.sp_getapplock @Resource=@scope,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000;
      IF @lock<0 THROW 50001,'Sync is busy, retry shortly',1;
      DELETE TOP(5) FROM dbo.AppSyncJob WHERE ExpiresAt<SYSUTCDATETIME();
      DECLARE @existing uniqueidentifier;
      SELECT TOP(1) @existing=Id FROM dbo.AppSyncJob WHERE ScopeKey=@scope
        AND ExpiresAt>SYSUTCDATETIME() AND ((Status='ready' AND UpdatedAt>DATEADD(second,-@freshSeconds,SYSUTCDATETIME())) OR (Status='processing' AND UpdatedAt>DATEADD(second,-900,SYSUTCDATETIME()))) ORDER BY CreatedAt DESC;
      IF @existing IS NULL BEGIN
        INSERT dbo.AppSyncJob(Id,ScopeKey,TenantId,UserId,Status,ExpiresAt) VALUES(@id,@scope,@tenant,@user,'processing',DATEADD(hour,2,SYSUTCDATETIME()));
        SET @existing=@id;
      END;
      SELECT * FROM dbo.AppSyncJob WHERE Id=@existing; COMMIT;`);
  const job = publicJob(result.recordset[0]);
  if (job.jobId !== id) return job;
  if (!run) return job;
  // Backpressure holds only one 5,000-row batch. Pages survive serverless
  // instance changes; status and downloads never depend on a JS Map.
  const work = (async () => {
    let page = 0, count = 0;
    const summary = await run(async rows => {
      const payload = await compress(Buffer.from(JSON.stringify(rows)));
      page += 1; count += rows.length;
      await db.request().input('id', sql.UniqueIdentifier, id).input('page', sql.Int, page)
        .input('payload', sql.VarBinary(sql.MAX), payload).input('total', sql.Int, count)
        .query(`INSERT dbo.AppSyncPage(JobId,Page,Payload) VALUES(@id,@page,@payload);
          UPDATE dbo.AppSyncJob SET Total=@total,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id AND Status='processing'`);
    });
    await db.request().input('id', sql.UniqueIdentifier, id).input('source', sql.Int, summary.sourceCount ?? count)
      .input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(summary))
      .query("UPDATE dbo.AppSyncJob SET Status='ready',SourceCount=@source,Metadata=@metadata,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id AND Status='processing'");
  })().catch(async error => {
    console.error('[SyncPageStore]', kind, options.tenantId, error.message);
    await db.request().input('id', sql.UniqueIdentifier, id)
      .query("UPDATE dbo.AppSyncJob SET Status='failed',Error='Unable to prepare sync data. Please retry.',UpdatedAt=SYSUTCDATETIME() WHERE Id=@id");
  }).catch(error => {
    // If the sync database is temporarily unavailable, polling detects stale
    // jobs. Do not let an error while saving the error crash the process.
    console.error('[SyncPageStore] Unable to record failure:', error.code || error.name);
  });
  waitUntil(work);
  return job;
}

async function readPage(job, requestedPage) {
  const page = Math.max(1, parseInt(requestedPage, 10) || 1);
  const db = await initialize();
  const result = await db.request().input('id', sql.UniqueIdentifier, job.jobId).input('page', sql.Int, page)
    .query('SELECT Payload FROM dbo.AppSyncPage WHERE JobId=@id AND Page=@page');
  const data = result.recordset[0] ? JSON.parse((await decompress(result.recordset[0].Payload)).toString()) : [];
  if (!data.length && (page - 1) * 5000 < job.count) throw new Error('Sync page is unavailable');
  return { data, count: data.length, page, pageSize: 5000, total: job.count, hasMore: page * 5000 < job.count };
}
async function waitForJob(job, tenantId, userId) {
  const deadline = Date.now() + 260000;
  while (job.status === 'processing' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    job = await findJob(job.jobId, tenantId, userId);
    if (!job) throw new Error('Sync expired. Please retry.');
  }
  if (job.status !== 'ready') throw new Error(job.error || 'Sync is still preparing. Please retry.');
  return job;
}
async function saveMetadata(jobId, metadata) {
  const db = await initialize();
  await db.request().input('id', sql.UniqueIdentifier, jobId).input('metadata', sql.NVarChar(sql.MAX), JSON.stringify(metadata))
    .query("UPDATE dbo.AppSyncJob SET Metadata=@metadata,LeaseUntil=NULL,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id AND Status='processing'");
}
async function storePage(jobId, page, rows) {
  const db = await initialize();
  const payload = await compress(Buffer.from(JSON.stringify(rows)));
  await db.request().input('id', sql.UniqueIdentifier, jobId).input('page', sql.Int, page).input('payload', sql.VarBinary(sql.MAX), payload)
    .query(`UPDATE dbo.AppSyncPage SET Payload=@payload WHERE JobId=@id AND Page=@page;
      IF @@ROWCOUNT=0 INSERT dbo.AppSyncPage(JobId,Page,Payload) VALUES(@id,@page,@payload);`);
}
async function completeJob(jobId, count, sourceCount) {
  const db = await initialize();
  await db.request().input('id', sql.UniqueIdentifier, jobId).input('total', sql.Int, count).input('source', sql.Int, sourceCount)
    .query("UPDATE dbo.AppSyncJob SET Status='ready',Total=@total,SourceCount=@source,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id");
}
async function failJob(jobId) {
  const db = await initialize();
  await db.request().input('id', sql.UniqueIdentifier, jobId)
    .query("UPDATE dbo.AppSyncJob SET Status='failed',Error='Unable to prepare stock. Please retry.',UpdatedAt=SYSUTCDATETIME() WHERE Id=@id");
}
async function claimStep(jobId) {
  const db = await initialize();
  const result = await db.request().input('id', sql.UniqueIdentifier, jobId).query(`
    UPDATE dbo.AppSyncJob SET LeaseUntil=DATEADD(second,90,SYSUTCDATETIME())
    OUTPUT inserted.Id WHERE Id=@id AND Status='processing' AND
    (LeaseUntil IS NULL OR LeaseUntil<SYSUTCDATETIME());`);
  return result.recordset.length > 0;
}
module.exports = { startJob, findJob, readPage, waitForJob, saveMetadata, storePage, completeJob, failJob, claimStep };
