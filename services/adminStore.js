const crypto = require("node:crypto");
const { sql, getPoolForTenant } = require("../config/db");
const fail = (message, statusCode = 400, code = "ADMIN_INVALID_REQUEST") =>
  Object.assign(new Error(message), { statusCode, code });
const digest = (value) =>
  crypto.createHash("sha256").update(String(value)).digest("hex");
const schemaSql = `SET XACT_ABORT ON;
BEGIN TRY
 BEGIN TRANSACTION;
 DECLARE @lock int; EXEC @lock=sys.sp_getapplock @Resource='CherryAdminSchemaV1',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000;
 IF @lock<0 THROW 51000,'Admin schema is busy',1;
 IF OBJECT_ID('dbo.POSAdminRestrictions') IS NULL CREATE TABLE dbo.POSAdminRestrictions (
  TenantId nvarchar(100) NOT NULL,CompanyCode nvarchar(100) NOT NULL,UserId nvarchar(100) NOT NULL,Scope nvarchar(20) NOT NULL,
  Restricted bit NOT NULL,Reason nvarchar(1000) NOT NULL,UpdatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),UpdatedBy nvarchar(254) NOT NULL,
  CONSTRAINT PK_POSAdminRestrictions PRIMARY KEY(Scope,TenantId,CompanyCode,UserId));
 -- Upgrade the original three-column key without deleting any restriction rows.
 IF NOT EXISTS (SELECT 1 FROM sys.key_constraints k JOIN sys.index_columns i ON i.object_id=k.parent_object_id AND i.index_id=k.unique_index_id JOIN sys.columns c ON c.object_id=i.object_id AND c.column_id=i.column_id WHERE k.parent_object_id=OBJECT_ID('dbo.POSAdminRestrictions') AND k.type='PK' AND c.name='Scope')
 BEGIN
  DECLARE @restrictionPk sysname;
  SELECT @restrictionPk=name FROM sys.key_constraints WHERE parent_object_id=OBJECT_ID('dbo.POSAdminRestrictions') AND type='PK';
  IF @restrictionPk IS NOT NULL BEGIN
   DECLARE @restrictionMigration nvarchar(max) = N'ALTER TABLE dbo.POSAdminRestrictions DROP CONSTRAINT '+QUOTENAME(@restrictionPk);
   EXEC(@restrictionMigration);
  END;
  ALTER TABLE dbo.POSAdminRestrictions ADD CONSTRAINT PK_POSAdminRestrictions PRIMARY KEY(Scope,TenantId,CompanyCode,UserId);
 END;
 IF OBJECT_ID('dbo.POSAdminTasks') IS NULL CREATE TABLE dbo.POSAdminTasks (
  Id uniqueidentifier NOT NULL PRIMARY KEY,Title nvarchar(200) NOT NULL,Description nvarchar(max) NOT NULL,Status nvarchar(20) NOT NULL,Priority nvarchar(20) NOT NULL,
  DueDate datetime2 NULL,TenantId nvarchar(100) NOT NULL,CompanyCode nvarchar(100) NOT NULL,UserId nvarchar(100) NOT NULL,
  CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),UpdatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME());
 IF OBJECT_ID('dbo.POSAdminSessions') IS NULL CREATE TABLE dbo.POSAdminSessions (
  SessionHash char(64) NOT NULL PRIMARY KEY,Email nvarchar(254) NOT NULL,ExpiresAt datetime2 NOT NULL,RevokedAt datetime2 NULL,CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME());
 IF OBJECT_ID('dbo.POSAdminAttempts') IS NULL CREATE TABLE dbo.POSAdminAttempts (
  Bucket char(64) NOT NULL PRIMARY KEY,WindowStart datetime2 NOT NULL,Attempts int NOT NULL);
 IF OBJECT_ID('dbo.POSAdminAudit') IS NULL CREATE TABLE dbo.POSAdminAudit (
  Id bigint IDENTITY PRIMARY KEY,Actor nvarchar(254) NOT NULL,Action nvarchar(80) NOT NULL,Target nvarchar(500) NOT NULL,CreatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME());
 COMMIT TRANSACTION;
END TRY BEGIN CATCH IF @@TRANCOUNT>0 ROLLBACK TRANSACTION; THROW; END CATCH;`;
const aliases = {
  TenantId: "tenantId",
  CompanyCode: "companyCode",
  UserId: "userId",
  Scope: "scope",
  Restricted: "restricted",
  Reason: "reason",
  UpdatedAt: "updatedAt",
  UpdatedBy: "updatedBy",
  Id: "id",
  Title: "title",
  Description: "description",
  Status: "status",
  Priority: "priority",
  DueDate: "dueDate",
  CreatedAt: "createdAt",
  Email: "email",
  ExpiresAt: "expiresAt",
  RevokedAt: "revokedAt",
};
const mapRow = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [aliases[key] || key, value]),
  );
function createAdminStore(poolProvider = getPoolForTenant) {
  let schemaReady = null,
    storeId = "";
  async function pool() {
    const id = process.env.ADMIN_STORE_TENANT_ID || "tenant_1";
    const db = await poolProvider(id);
    if (!schemaReady || id !== storeId) {
      storeId = id;
      schemaReady = db
        .request()
        .query(schemaSql)
        .catch((e) => {
          schemaReady = null;
          throw e;
        });
    }
    await schemaReady;
    return db;
  }
  async function query(text, params = {}) {
    const request = (await pool()).request();
    for (const [key, value] of Object.entries(params)) {
      const type =
        value instanceof Date
          ? sql.DateTime2
          : typeof value === "boolean"
            ? sql.Bit
            : typeof value === "number"
              ? sql.Int
              : sql.NVarChar(sql.MAX);
      request.input(key, type, value);
    }
    if (text.includes("BEGIN TRANSACTION") && !text.includes("BEGIN TRY"))
      text =
        "BEGIN TRY " +
        text +
        " END TRY BEGIN CATCH IF @@TRANCOUNT>0 ROLLBACK TRANSACTION; THROW; END CATCH;";
    return request.query(text);
  }
  async function audit(actor, action, target) {
    await query(
      "INSERT INTO dbo.POSAdminAudit(Actor,Action,Target) VALUES(@actor,@action,@target)",
      { actor, action, target },
    );
  }
  async function restrictions() {
    return (
      await query(
        "SELECT * FROM dbo.POSAdminRestrictions ORDER BY UpdatedAt DESC",
      )
    ).recordset.map(mapRow);
  }
  async function checkAccess({ tenantId, companyCode, userId }) {
    if (!tenantId || !String(userId || "").trim())
      throw fail(
        "Sign in again to check company access.",
        401,
        "ACCESS_IDENTITY_REQUIRED",
      );
    const rows = (
      await query(
        `SELECT TOP 1 Scope,Reason FROM dbo.POSAdminRestrictions WHERE Restricted=1 AND TenantId=@tenantId AND ((Scope='tenant' AND CompanyCode='' AND UserId='') OR (Scope='company' AND CompanyCode=@companyCode AND UserId='') OR (Scope='user' AND CompanyCode=@companyCode AND UserId=@userId)) ORDER BY CASE Scope WHEN 'tenant' THEN 0 WHEN 'company' THEN 1 ELSE 2 END`,
        {
          tenantId: String(tenantId),
          companyCode: String(companyCode ?? "").trim(),
          userId: String(userId).trim(),
        },
      )
    ).recordset;
    return rows[0] ? mapRow(rows[0]) : null;
  }
  async function setRestriction(row, actor) {
    await query(
      `SET XACT_ABORT ON; BEGIN TRANSACTION;
 UPDATE dbo.POSAdminRestrictions WITH(UPDLOCK,SERIALIZABLE) SET Scope=@scope,Restricted=@restricted,Reason=@reason,UpdatedAt=SYSUTCDATETIME(),UpdatedBy=@actor WHERE Scope=@scope AND TenantId=@tenantId AND CompanyCode=@companyCode AND UserId=@userId;
 IF @@ROWCOUNT=0 INSERT INTO dbo.POSAdminRestrictions(TenantId,CompanyCode,UserId,Scope,Restricted,Reason,UpdatedBy) VALUES(@tenantId,@companyCode,@userId,@scope,@restricted,@reason,@actor);
 INSERT INTO dbo.POSAdminAudit(Actor,Action,Target) VALUES(@actor,'restriction.changed',@auditTarget); COMMIT;`,
      {
        ...row,
        actor,
        auditTarget: JSON.stringify({
          tenantId: row.tenantId,
          companyCode: row.companyCode,
          userId: row.userId,
          scope: row.scope,
          restricted: row.restricted,
        }),
      },
    );
  }
  async function rateLimit(bucket, limit) {
    const result = await query(
      `SET XACT_ABORT ON; BEGIN TRANSACTION;
 UPDATE dbo.POSAdminAttempts WITH(UPDLOCK,SERIALIZABLE) SET Attempts=CASE WHEN WindowStart<DATEADD(minute,-15,SYSUTCDATETIME()) THEN 1 ELSE Attempts+1 END,WindowStart=CASE WHEN WindowStart<DATEADD(minute,-15,SYSUTCDATETIME()) THEN SYSUTCDATETIME() ELSE WindowStart END WHERE Bucket=@bucket;
 IF @@ROWCOUNT=0 INSERT INTO dbo.POSAdminAttempts(Bucket,WindowStart,Attempts) VALUES(@bucket,SYSUTCDATETIME(),1);
 SELECT Attempts FROM dbo.POSAdminAttempts WHERE Bucket=@bucket; COMMIT;`,
      { bucket: digest(bucket) },
    );
    if (result.recordset[0].Attempts > limit)
      throw fail(
        "Too many attempts. Try again in 15 minutes.",
        429,
        "ADMIN_RATE_LIMITED",
      );
  }
  async function createSession(sid, email, expiresAt) {
    await query(
      "INSERT INTO dbo.POSAdminSessions(SessionHash,Email,ExpiresAt) VALUES(@hash,@email,@expiresAt)",
      { hash: digest(sid), email, expiresAt: new Date(expiresAt) },
    );
  }
  async function session(sid) {
    const r = await query(
      "SELECT Email,ExpiresAt FROM dbo.POSAdminSessions WHERE SessionHash=@hash AND RevokedAt IS NULL AND ExpiresAt>SYSUTCDATETIME()",
      { hash: digest(sid) },
    );
    return r.recordset[0] ? mapRow(r.recordset[0]) : null;
  }
  async function revokeSession(sid) {
    await query(
      "UPDATE dbo.POSAdminSessions SET RevokedAt=SYSUTCDATETIME() WHERE SessionHash=@hash",
      { hash: digest(sid) },
    );
  }
  async function tasks() {
    return (
      await query(
        "SELECT * FROM dbo.POSAdminTasks ORDER BY CASE Status WHEN 'done' THEN 1 ELSE 0 END,CreatedAt DESC",
      )
    ).recordset.map(mapRow);
  }
  async function saveTask(task, actor, create = false) {
    const fields = { ...task, actor, auditTarget: task.id };
    const result = await query(
      create
        ? `SET XACT_ABORT ON;BEGIN TRANSACTION; INSERT INTO dbo.POSAdminTasks(Id,Title,Description,Status,Priority,DueDate,TenantId,CompanyCode,UserId) VALUES(@id,@title,@description,@status,@priority,@dueDate,@tenantId,@companyCode,@userId); INSERT INTO dbo.POSAdminAudit(Actor,Action,Target) VALUES(@actor,'task.created',@auditTarget); SELECT * FROM dbo.POSAdminTasks WHERE Id=@id;COMMIT;`
        : `SET XACT_ABORT ON;BEGIN TRANSACTION; UPDATE dbo.POSAdminTasks SET Title=@title,Description=@description,Status=@status,Priority=@priority,DueDate=@dueDate,TenantId=@tenantId,CompanyCode=@companyCode,UserId=@userId,UpdatedAt=SYSUTCDATETIME() WHERE Id=@id; IF @@ROWCOUNT=0 THROW 51001,'Task not found',1; INSERT INTO dbo.POSAdminAudit(Actor,Action,Target) VALUES(@actor,'task.updated',@auditTarget);SELECT * FROM dbo.POSAdminTasks WHERE Id=@id;COMMIT;`,
      fields,
    );
    return mapRow(result.recordset[0]);
  }
  async function deleteTask(id, actor) {
    await query(
      `SET XACT_ABORT ON;BEGIN TRANSACTION; DELETE FROM dbo.POSAdminTasks WHERE Id=@id; INSERT INTO dbo.POSAdminAudit(Actor,Action,Target) VALUES(@actor,'task.deleted',@id);COMMIT;`,
      { id, actor },
    );
  }
  return {
    restrictions,
    checkAccess,
    setRestriction,
    rateLimit,
    createSession,
    session,
    revokeSession,
    tasks,
    saveTask,
    deleteTask,
    audit,
  };
}
const adminStore = createAdminStore();
module.exports = { createAdminStore, adminStore, schemaSql, fail, digest };

