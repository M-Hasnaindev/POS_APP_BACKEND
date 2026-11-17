"use strict";
/**
 * Daily question limit for the Claude business assistant.
 *
 * One row per user per Pakistan day in dbo.AppAiAssistantUsage (tenant DB).
 * Only a new user question is counted; the tool-result turns Claude needs to
 * answer it are free. Check and count happen in one locked transaction so two
 * tabs cannot pass the limit together. A question whose Claude call fails is
 * given back (refund).
 *
 * ASSISTANT_DAILY_LIMIT sets the limit (default 10, 0 = no limit).
 * If a company's database does not have the table yet, the assistant keeps
 * working without a limit there (logged once per tenant).
 */
const sql = require("mssql");
const { getPoolForTenant } = require("../config/db");

const PK_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan is UTC+5 all year (no DST).
const missingTable = new Set();

function dailyLimit() {
  const value = Number(process.env.ASSISTANT_DAILY_LIMIT ?? 10);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Today's date in Pakistan (YYYY-MM-DD) and the moment the count resets. */
function pakistanDay(now = Date.now()) {
  const local = new Date(now + PK_OFFSET_MS);
  const day = local.toISOString().slice(0, 10);
  const nextMidnightUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - PK_OFFSET_MS;
  return { day, resetsAt: new Date(nextMidnightUtc).toISOString() };
}

/** Same UserID can exist under two company codes in one tenant DB. */
function usageUserKey(user) {
  const userId = String(user?.userId ?? "").trim();
  const company = String(user?.companyCode ?? "").trim();
  return (company ? `${company}:${userId}` : userId).slice(0, 50);
}

/**
 * A turn starts a new question when its last user message is the user's own
 * text. Follow-up turns carry tool_result blocks and are not counted.
 */
function isNewQuestion(messages) {
  const last = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (!last || last.role !== "user") return false;
  if (typeof last.content === "string") return true;
  return Array.isArray(last.content) && !last.content.some((block) => block?.type === "tool_result");
}

const isMissingTable = (error) => /AppAiAssistantUsage/i.test(String(error?.message || "")) && /invalid object name/i.test(String(error?.message || ""));

function noteMissingTable(tenantId) {
  if (missingTable.has(tenantId)) return;
  missingTable.add(tenantId);
  console.warn(`[assistant-usage] dbo.AppAiAssistantUsage not found for ${tenantId}; daily limit is off for this company.`);
}

const summary = (limit, used, resetsAt) => ({
  limit,
  used,
  remaining: limit ? Math.max(0, limit - used) : null,
  resetsAt,
});

/** Count one question if the user still has questions left today. */
async function consumeQuestion(user) {
  const limit = dailyLimit();
  const { day, resetsAt } = pakistanDay();
  if (!limit) return { allowed: true, counted: false, ...summary(0, 0, resetsAt) };
  try {
    const pool = await getPoolForTenant(user.tenantId);
    const result = await pool.request()
      .input("userId", sql.NVarChar(50), usageUserKey(user))
      .input("day", sql.Date, day)
      .input("limit", sql.Int, limit)
      .query(`
        SET NOCOUNT ON;
        SET XACT_ABORT ON;
        DECLARE @used INT, @allowed BIT = 0;
        BEGIN TRAN;
          SELECT @used = MessageCount
          FROM dbo.AppAiAssistantUsage WITH (UPDLOCK, HOLDLOCK)
          WHERE UserId = @userId AND UsageDate = @day;
          IF @used IS NULL
          BEGIN
            INSERT dbo.AppAiAssistantUsage (UserId, UsageDate, MessageCount, LastMessageAt)
            VALUES (@userId, @day, 1, SYSUTCDATETIME());
            SELECT @used = 1, @allowed = 1;
          END
          ELSE IF @used < @limit
          BEGIN
            UPDATE dbo.AppAiAssistantUsage
            SET MessageCount = MessageCount + 1, LastMessageAt = SYSUTCDATETIME()
            WHERE UserId = @userId AND UsageDate = @day;
            SELECT @used = @used + 1, @allowed = 1;
          END
        COMMIT;
        SELECT @allowed AS allowed, @used AS used;
      `);
    const row = result.recordset[0] || {};
    const allowed = Boolean(row.allowed);
    return { allowed, counted: allowed, day, ...summary(limit, Number(row.used) || 0, resetsAt) };
  } catch (error) {
    if (isMissingTable(error)) {
      noteMissingTable(user.tenantId);
      return { allowed: true, counted: false, ...summary(0, 0, resetsAt) };
    }
    throw error;
  }
}

/** Give a counted question back when Claude could not answer it. */
async function refundQuestion(user, day) {
  try {
    const pool = await getPoolForTenant(user.tenantId);
    await pool.request()
      .input("userId", sql.NVarChar(50), usageUserKey(user))
      .input("day", sql.Date, day)
      .query(`
        UPDATE dbo.AppAiAssistantUsage
        SET MessageCount = MessageCount - 1
        WHERE UserId = @userId AND UsageDate = @day AND MessageCount > 0;
      `);
  } catch (error) {
    console.error("[assistant-usage] refund failed", error?.message || error);
  }
}

/** Today's count without changing it (for the app to show "N left today"). */
async function readUsage(user) {
  const limit = dailyLimit();
  const { day, resetsAt } = pakistanDay();
  if (!limit) return summary(0, 0, resetsAt);
  try {
    const pool = await getPoolForTenant(user.tenantId);
    const result = await pool.request()
      .input("userId", sql.NVarChar(50), usageUserKey(user))
      .input("day", sql.Date, day)
      .query("SELECT MessageCount FROM dbo.AppAiAssistantUsage WHERE UserId = @userId AND UsageDate = @day");
    return summary(limit, Number(result.recordset[0]?.MessageCount) || 0, resetsAt);
  } catch (error) {
    if (isMissingTable(error)) { noteMissingTable(user.tenantId); return summary(0, 0, resetsAt); }
    throw error;
  }
}

module.exports = { consumeQuestion, refundQuestion, readUsage, isNewQuestion, pakistanDay, usageUserKey, dailyLimit };
