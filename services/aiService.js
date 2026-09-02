const { sql, getPoolForTenant } = require("../config/db");
const aiConfig = require("../config/ai");
const { allowedTables, businessRules, tablePurposes, selectRelevantTables } = require("../ai/knowledge");
const { validateReadOnlySql } = require("../ai/sqlSafety");
const { ollamaChat } = require("./ollamaService");
const reportService = require("./reportService");

function compactReport(report) {
  return {
    title: report.title,
    filters: report.filters,
    kpis: report.kpis,
    rows: (report.rows || []).slice(0, 12),
    note: report.note,
  };
}

function fallbackNarrative(report) {
  const facts = (report.kpis || []).map((kpi) => `${kpi.label}: ${Number(kpi.value || 0).toLocaleString("en-PK")}`);
  return {
    summary: facts.length ? facts.join(". ") : "Live data returned no measurable result for this scope.",
    keyPoints: facts.slice(0, 4),
    actions: report.rows?.length ? ["Review the strongest and weakest rows in the breakdown below."] : ["Widen the date or business filters if you expected activity."],
  };
}

async function generateReportNarrative(report, languageHint = "English") {
  try {
    const response = await ollamaChat([
      { role: "system", content: `You are Cherry AI, a careful POS management analyst. Use ONLY the supplied live figures. Never invent a number. Reply in ${languageHint}. Return JSON with summary (detailed but concise string), keyPoints (2-4 strings), and actions (1-3 practical strings). Money is PKR/Rs.` },
      { role: "user", content: JSON.stringify(compactReport(report)) },
    ], { json: true, temperature: 0.1 });
    return {
      summary: String(response.summary || "").trim(),
      keyPoints: Array.isArray(response.keyPoints) ? response.keyPoints.map(String).slice(0, 4) : [],
      actions: Array.isArray(response.actions) ? response.actions.map(String).slice(0, 3) : [],
    };
  } catch (error) {
    return { ...fallbackNarrative(report), warning: `AI narrative unavailable: ${error.message}` };
  }
}

function detectRomanUrdu(text) {
  return /\b(bhai|batao|kitna|kitni|kitne|aaj|kal|is month|iss month|pichla|branch wise|ka|ki|ke|mera|mujhe)\b/i.test(text);
}

function inferFilters(message) {
  const text = String(message || "");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  let fromDate = `${today.slice(0, 8)}01`;
  let toDate = today;
  if (/\b(aaj|today)\b/i.test(text)) fromDate = toDate = today;
  if (/\b(yesterday|kal)\b/i.test(text)) {
    const date = new Date(`${today}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 1);
    fromDate = toDate = date.toISOString().slice(0, 10);
  }
  if (/\b(last month|pichla month|pichlay month)\b/i.test(text)) {
    const current = new Date(`${today}T00:00:00Z`);
    const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0));
    fromDate = first.toISOString().slice(0, 10); toDate = last.toISOString().slice(0, 10);
  }
  const explicit = [...text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)].map((match) => match[0]);
  if (explicit.length) fromDate = explicit[0];
  if (explicit.length > 1) toDate = explicit[1];
  const barcode = text.match(/\b\d{6,18}\b/)?.[0];
  return { fromDate, toDate, ...(barcode ? { barcodes: [barcode] } : {}) };
}

function chooseFastReport(message) {
  const text = String(message || "").toLowerCase();
  if (/purchase return|supplier return|purchase waps/.test(text)) return "RPT_05_009_PURCHASE_RETURN";
  if (/discount policy|discount applies|discount lage|active discount/.test(text)) return "RPT_16_016_DISCOUNT_POLICY_COMPLIANCE";
  if (/fbr|gst|taxable sales|tax summary/.test(text)) return "RPT_26_001_FBR_SALES_SUMMARY";
  if (/payment|cash.*card|card.*credit/.test(text)) return "RPT_02_032_CASH_CARD_CREDIT_SALES";
  if (/transfer|in transit|received/.test(text)) return "RPT_06_013_SENT_VS_RECEIVED_QUANTITY";
  if (/stock take|physical stock|physical count/.test(text)) return "RPT_03_001_CURRENT_STOCK";
  if (/stock adjustment|stock adj/.test(text)) return "RPT_03_002_BARCODE_STOCK_LEDGER";
  if (/current stock|available stock|stock balance|maal kitna|on hand/.test(text)) return "RPT_03_001_CURRENT_STOCK";
  if (/purchase|purchasing|kharid|khareed/.test(text)) {
    if (/supplier wise|party wise|vendor wise/.test(text)) return "RPT_05_003_SUPPLIER_WISE_PURCHASE";
    return "RPT_05_001_PURCHASE_REGISTER";
  }
  if (/sale|sales|selling|farokht|revenue|profit|margin/.test(text)) {
    if (/branch wise/.test(text)) return "RPT_02_005_BRANCH_WISE_SALES";
    if (/store wise|stockroom wise/.test(text)) return "RPT_02_006_STORE_WISE_SALES";
    if (/brand wise/.test(text)) return "RPT_02_010_BRAND_WISE_SALES";
    if (/category wise|catagory wise/.test(text)) return "RPT_02_012_CATEGORY_WISE_SALES";
    if (/barcode wise|product wise|item wise/.test(text)) return "RPT_02_008_BARCODE_WISE_SALES";
    if (/daily|day wise/.test(text)) return "RPT_02_002_DAILY_SALES";
    return "RPT_02_001_SALES_SUMMARY";
  }
  return null;
}

function assistantAnswerFromReport(report, narrative) {
  return {
    mode: "report",
    answer: narrative.summary,
    keyPoints: narrative.keyPoints,
    actions: narrative.actions,
    report,
    visualization: report.charts?.[0] || null,
    warning: narrative.warning || null,
  };
}

async function getSchema(pool, requestedTables) {
  const safe = requestedTables.filter((name) => allowedTables.includes(name));
  if (!safe.length) return { tables: [], schemaText: "" };
  const request = pool.request();
  const params = safe.map((name, index) => {
    request.input(`table${index}`, sql.NVarChar(128), name);
    return `@table${index}`;
  });
  const result = await request.query(`SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN (${params.join(",")}) ORDER BY TABLE_NAME,ORDINAL_POSITION`);
  const grouped = {};
  for (const row of result.recordset || []) (grouped[row.TABLE_NAME] ||= []).push(`${row.COLUMN_NAME}:${row.DATA_TYPE}`);
  return {
    tables: Object.keys(grouped),
    schemaText: Object.entries(grouped).map(([name, columns]) => `${name}(${columns.join(", ")})`).join("\n"),
  };
}

async function executePlannedSql(pool, user, filters, query, liveTables) {
  const validation = validateReadOnlySql(query, liveTables);
  if (!/@companyCode\b/i.test(validation.sql)) throw new Error("AI query was blocked because company isolation was missing");
  const request = pool.request();
  request.timeout = aiConfig.sqlTimeoutMs;
  request.input("companyCode", sql.VarChar(20), String(user.companyCode || ""));
  request.input("fromDate", sql.Date, filters.fromDate);
  request.input("toDate", sql.Date, filters.toDate);
  const result = await request.query(validation.sql);
  return (result.recordset || []).slice(0, aiConfig.maxRows);
}

async function plannerFallback({ pool, user, message, history, filters }) {
  const relevant = selectRelevantTables(message);
  const schema = await getSchema(pool, relevant);
  const system = `You plan safe SQL Server 2014 queries for Cherry POS. Current question overrides history.
Return JSON only: {"mode":"sql|clarify|direct","sql":"","question":"","answer":""}.
Use one read-only SELECT or CTE only, no semicolon/comments, no SELECT *, and TOP ${aiConfig.maxRows} for non-aggregate detail.
Every transaction query MUST filter CompanyCode=@companyCode. Use @fromDate and @toDate for the requested period.
Detail tables are facts. Apply paid master BillStatus='P', Cancel!='Y', signed returns, and Pos/UnPos dedupe.
Never invent a field or relation. If required logic/table is absent, clarify. Money is PKR.
Rules:\n${businessRules.join("\n")}
Table purposes:\n${Object.entries(tablePurposes).filter(([name]) => schema.tables.includes(name)).map(([name, purpose]) => `${name}: ${purpose}`).join("\n")}
Live schema:\n${schema.schemaText}`;
  const planner = await ollamaChat([
    { role: "system", content: system },
    ...history.slice(-6).map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: String(item.content || "").slice(0, 800) })),
    { role: "user", content: `${message}\nResolved period: ${filters.fromDate} to ${filters.toDate}` },
  ], { json: true, temperature: 0 });
  if (planner.mode === "clarify") return { mode: "clarify", answer: String(planner.question || "Please clarify the missing business scope.") };
  if (planner.mode === "direct") return { mode: "direct", answer: String(planner.answer || "") };
  if (planner.mode !== "sql" || !planner.sql) throw new Error("AI planner returned an invalid plan");
  const rows = await executePlannedSql(pool, user, filters, planner.sql, schema.tables);
  const language = detectRomanUrdu(message) ? "clear Roman Urdu" : "clear business English";
  const answer = await ollamaChat([
    { role: "system", content: `Answer in ${language}. Use ONLY the supplied live rows. Keep exact numbers. Mention Amount with Quantity where meaningful. Do not expose SQL. If rows are empty, say no matching live data was found.` },
    { role: "user", content: JSON.stringify({ question: message, period: filters, rows: rows.slice(0, 80) }) },
  ], { temperature: 0.1 });
  return { mode: "sql", answer, rows, visualization: inferVisualization(rows) };
}

function inferVisualization(rows) {
  if (!rows?.length) return null;
  const columns = Object.keys(rows[0]);
  const label = columns.find((key) => typeof rows[0][key] === "string");
  const numeric = columns.find((key) => Number.isFinite(Number(rows[0][key])));
  if (!label || !numeric) return null;
  return { type: "bar", title: `${numeric} by ${label}`, data: rows.slice(0, 12).map((row) => ({ Label: String(row[label] ?? ""), Amount: Number(row[numeric] || 0) })) };
}

async function answerAssistant({ tenantId, user, message, history = [] }) {
  const question = String(message || "").trim();
  if (!question) throw Object.assign(new Error("Message is required"), { status: 400 });
  if (question.length > aiConfig.maxQuestionLength) throw Object.assign(new Error("Message is too long"), { status: 400 });
  if (/^(hi|hello|hey|salam|assalam|aoa|bhai)[!. ]*$/i.test(question)) {
    return { mode: "direct", answer: detectRomanUrdu(question) ? "Walekum salam bhai. Sales, purchase, stock, transfer, payment ya kisi report ke bare mein poochain." : "Hello. Ask me about live sales, purchase, stock, transfer, payments, or reports." };
  }
  const filters = inferFilters(question);
  const fastCode = chooseFastReport(question);
  if (fastCode) {
    const report = await reportService.runReport({ tenantId, user, code: fastCode, filters });
    const narrative = await generateReportNarrative(report, detectRomanUrdu(question) ? "clear Roman Urdu" : "clear business English");
    return assistantAnswerFromReport(report, narrative);
  }
  const pool = await getPoolForTenant(tenantId);
  try {
    return await plannerFallback({ pool, user, message: question, history: Array.isArray(history) ? history : [], filters });
  } catch (error) {
    return { mode: "clarify", answer: `I could not safely map that question to the live database. Please specify the business area and period. (${error.message})` };
  }
}

module.exports = { generateReportNarrative, answerAssistant, chooseFastReport, inferFilters };
