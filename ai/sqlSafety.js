const { allowedTables } = require("./knowledge");

const blocked = /\b(insert|update|delete|merge|drop|alter|create|truncate|exec(?:ute)?|grant|revoke|deny|backup|restore|dbcc|kill|use|openrowset|opendatasource|bulk|waitfor|shutdown)\b/i;
const commentOrBatch = /(--|\/\*|\*\/|;|\bgo\b)/i;
const systemAccess = /\b(sys\.|information_schema\.|master\.|msdb\.|tempdb\.)/i;
const selectStar = /\bselect\s+(?:top\s*\(?\s*\d+\s*\)?\s+)?\*/i;
const aliasStar = /\b[a-zA-Z_][\w$]*\.\*/i;

function stripIdentifiers(value) {
  return String(value || "").replace(/\[([^\]]+)\]/g, "$1");
}

function extractCteNames(query) {
  const normalized = stripIdentifiers(query);
  return new Set(
    [...normalized.matchAll(/(?:\bwith\b|,)\s*([a-zA-Z_][\w$]*)\s+as\s*\(/gi)]
      .map((match) => match[1].toLowerCase()),
  );
}

function extractTables(query) {
  const normalized = stripIdentifiers(query);
  const tables = new Set();
  const regex = /\b(?:from|join)\s+(?:(dbo)\.)?([a-zA-Z_][\w$]*)/gi;
  let match;
  while ((match = regex.exec(normalized))) tables.add(match[2]);
  return [...tables];
}

function validateReadOnlySql(query, liveTables = allowedTables) {
  const text = String(query || "").trim();
  if (!text) throw new Error("AI did not return a SQL query");
  if (!/^(select|with)\b/i.test(text)) throw new Error("Only SELECT/CTE queries are allowed");
  if (text.length > 24000) throw new Error("SQL query is too large");
  if (blocked.test(text) || commentOrBatch.test(text) || systemAccess.test(text)) {
    throw new Error("Unsafe SQL was blocked");
  }
  if (selectStar.test(text) || aliasStar.test(text)) throw new Error("SELECT * is not allowed");

  const allowed = new Set(liveTables.map((value) => String(value).toLowerCase()));
  const cteNames = extractCteNames(text);
  const tables = extractTables(text).filter((table) => !cteNames.has(table.toLowerCase()));
  const denied = tables.filter((table) => !allowed.has(table.toLowerCase()));
  if (denied.length) throw new Error(`Query references unavailable table(s): ${denied.join(", ")}`);
  if (!tables.length) throw new Error("Query does not reference an allowed live table");
  return { sql: text, tables };
}

module.exports = { validateReadOnlySql, extractTables, extractCteNames };
