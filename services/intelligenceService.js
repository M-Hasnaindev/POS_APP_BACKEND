const { APPROVED_TABLES } = require("./knowledgeResourceService");
const { BUSINESS_RULES, METRICS, RELATIONSHIPS, getReport } = require("./businessCatalogService");

const forbiddenSql = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|pragma|vacuum|reindex|truncate|grant|revoke|exec(?:ute)?|load_extension)\b/i;

function ollamaConfig() {
  const primaryModel = String(process.env.OLLAMA_MODEL || "gpt-oss:20b-cloud").trim();
  const fallbackModels = String(process.env.OLLAMA_MODEL_CANDIDATES || process.env.OLLAMA_FALLBACK_MODELS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return {
    baseUrl: String(process.env.OLLAMA_BASE_URL || "https://ollama.com").replace(/\/$/, ""),
    apiKey: String(process.env.OLLAMA_API_KEY || process.env.OLLAMA_AUTH_TOKEN || "").trim(),
    models: [...new Set([primaryModel, ...fallbackModels])],
    timeout: Math.max(10000, Math.min(Number(process.env.OLLAMA_TIMEOUT_MS || 60000), 120000)),
  };
}

function extractJson(value) {
  const text = String(value || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI did not return a structured plan");
  return JSON.parse(text.slice(start, end + 1));
}

async function chat(messages, { json = false, temperature = 0.1 } = {}) {
  const config = ollamaConfig();
  if (!config.apiKey) {
    const error = new Error("Assistant model is not configured on the backend");
    error.status = 503;
    throw error;
  }
  let lastError;
  const attempts = config.models.slice(0, 3);
  for (let index = 0; index < attempts.length; index += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeout);
    try {
      const response = await fetch(`${config.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: attempts[index], messages, stream: false, think: json ? false : "low", format: json ? "json" : undefined, options: { temperature, num_ctx: 24576, num_predict: json ? 2400 : 2200 } }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(new Error(body?.error || `Assistant model returned ${response.status}`), { status: response.status });
      const content = body?.message?.content || body?.message?.thinking;
      if (!content) throw new Error("Assistant model returned an empty response");
      return content;
    } catch (error) {
      lastError = error?.name === "AbortError"
        ? Object.assign(new Error("Assistant planning timed out; retrying safely"), { status: 504 })
        : error;
      const retryable = error?.name === "AbortError" || Number(error?.status || 500) >= 500;
      if (!retryable) throw error;
    } finally { clearTimeout(timer); }
  }
  throw Object.assign(lastError || new Error("Assistant model is temporarily unavailable"), { status: lastError?.status || 503 });
}

function safeSchema(value) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(APPROVED_TABLES.map((name) => name.toLowerCase()));
  return value.filter((table) => allowed.has(String(table?.name || "").toLowerCase())).slice(0, 32).map((table) => ({
    name: String(table.name),
    columns: Array.isArray(table.columns) ? table.columns.map((column) => String(column)).filter(Boolean).slice(0, 150) : [],
  }));
}

function validateSql(sql, schema) {
  const value = String(sql || "").trim().replace(/;+\s*$/, "").replace(/\b([A-Za-z_][\w]*\.)?([A-Za-z_][\w]*Date)\s+BETWEEN/gi, (_match, alias, column) => `date(${alias || ""}${column}) BETWEEN`);
  if (!/^(select|with)\b/i.test(value) || value.includes(";") || forbiddenSql.test(value)) throw new Error("Assistant produced an unsafe query");
  const available = new Set(schema.map((table) => table.name.toLowerCase()));
  for (const match of value.matchAll(/(?:\bwith|,)\s*([a-zA-Z0-9_]+)\s+as\s*\(/gi)) available.add(match[1].toLowerCase());
  const referenced = [...value.matchAll(/\b(?:from|join)\s+["`\[]?([a-zA-Z0-9_]+)/gi)].map((match) => match[1].toLowerCase());
  if (!referenced.length || referenced.some((name) => !available.has(name))) throw new Error("Assistant query references an unavailable table");
  return value;
}

function exactColumn(schema,name,column){const table=schema.find(item=>item.name.toLowerCase()===name.toLowerCase());return table?.columns.find(item=>item.toLowerCase()===column.toLowerCase())||null}
function fastSalesPlan(question,schema){
  const q=String(question||"").toLowerCase();if(!/(sale|sales|farokht)/.test(q))return null;
  const required=[exactColumn(schema,"PosDetail","TransactionNumber"),exactColumn(schema,"PosDetail","TranDate"),exactColumn(schema,"PosDetail","NetAmount"),exactColumn(schema,"PosDetail","Quantity"),exactColumn(schema,"PosMaster","TransactionNumber"),exactColumn(schema,"PosMaster","BillStatus")];if(required.some(value=>!value))return null;
  const today=/(aaj|today)/.test(q);if(!today||!/(total|kitn|bata)/.test(q))return null;
  const cancel=exactColumn(schema,"PosDetail","Cancel");const where=cancel?` AND COALESCE(d.${cancel},'')<>'Y'`:"";
  const unReady=["TransactionNumber","TranDate","NetAmount","Quantity"].every(column=>exactColumn(schema,"UnPosDetail",column))&&["TransactionNumber","BillStatus"].every(column=>exactColumn(schema,"UnPosMaster",column));
  const unCancel=exactColumn(schema,"UnPosDetail","Cancel");const unWhere=unCancel?` AND COALESCE(u.${unCancel},'')<>'Y'`:"";
  const live=unReady?` UNION ALL SELECT u.TransactionNumber,u.NetAmount,u.Quantity FROM UnPosDetail u JOIN UnPosMaster um ON um.TransactionNumber=u.TransactionNumber WHERE um.BillStatus='P'${unWhere} AND date(u.TranDate)=date('now','+5 hours') AND NOT EXISTS (SELECT 1 FROM PosMaster pm WHERE pm.TransactionNumber=um.TransactionNumber${exactColumn(schema,"PosMaster","Branch")&&exactColumn(schema,"UnPosMaster","Branch")?" AND pm.Branch=um.Branch":""})`:"";
  const sql=`WITH sales AS (SELECT d.TransactionNumber,d.NetAmount,d.Quantity FROM PosDetail d JOIN PosMaster m ON m.TransactionNumber=d.TransactionNumber WHERE m.BillStatus='P'${where} AND date(d.TranDate)=date('now','+5 hours')${live}) SELECT COALESCE(SUM(NetAmount),0) AS TotalSales,COALESCE(SUM(Quantity),0) AS NetQuantity,COUNT(DISTINCT TransactionNumber) AS Bills FROM sales`;
  return{title:"Today's total sales",detailLevel:/detail|tafseel/.test(q)?"detailed":"short",needsClarification:false,clarification:"",queries:[{id:"main",purpose:"Today verified paid sales",sql}],visualization:{type:"none"}};
}

async function createPlan({ question, history, schema, language, permissions }) {
  const cleanQuestion = String(question || "").trim().slice(0, 2000);
  if (!cleanQuestion) throw Object.assign(new Error("Question is required"), { status: 400 });
  const cleanSchema = safeSchema(schema);
  if (!cleanSchema.length) throw Object.assign(new Error("Business resources are not ready"), { status: 409 });
  const recentHistory = Array.isArray(history) ? history.slice(-10).map((item) => ({ role: item?.role === "assistant" ? "assistant" : "user", content: String(item?.content || "").slice(0, 800) })) : [];
  const fastPlan=fastSalesPlan(cleanQuestion,cleanSchema);if(fastPlan)return fastPlan;
  const system = `You are Cherry POS Query Planner. Convert the user's business question into safe SQLite SELECT queries over a downloaded read-only POS snapshot.
Rules:
- Use only tables and exact columns supplied in SCHEMA. Never invent a column.
- Apply this authoritative business rule catalog: ${JSON.stringify(BUSINESS_RULES)}
- Apply these metric definitions: ${JSON.stringify(METRICS)}
- Apply these documented relationships: ${JSON.stringify(RELATIONSHIPS)}
- Exclude cancelled rows only when a supplied status/cancel column makes that possible.
- Sales returns can be negative. Current stock = opening + purchases - purchase returns - sales + sales returns - transfer out + transfer received +/- adjustments.
- Every paid sales total MUST combine PosDetail/PosMaster with UnPosDetail/UnPosMaster using UNION ALL, and exclude an UnPos document when the same Branch + TransactionNumber already exists in PosMaster.
- StockTake checks stock and does not change it.
- Never use current prices as historical cost.
- SQLite stores many SQL Server dates as ISO text. For a day comparison use date(column) and Pakistan today as date('now','+5 hours'); never compare a datetime column directly to date('now').
- Produce at most 3 queries. Each query must be one SELECT/WITH statement, no semicolon, no PRAGMA, no write operation, LIMIT <= 500.
- Detect short vs detailed response preference from wording.
Return JSON only: {"title":"...","detailLevel":"short|detailed","needsClarification":false,"clarification":"","queries":[{"id":"main","purpose":"...","sql":"..."}],"visualization":{"type":"none|bar|line|pie","queryId":"main","labelKey":"...","valueKey":"..."}}.`;
  const content = await chat([
    { role: "system", content: system },
    ...recentHistory,
    { role: "user", content: `Preferred language: ${String(language || "Roman Urdu")}.\nUSER PERMISSIONS (mandatory scope): ${JSON.stringify(permissions || {})}\nSCHEMA: ${JSON.stringify(cleanSchema)}\nQUESTION: ${cleanQuestion}` },
  ], { json: true });
  const plan = extractJson(content);
  if (plan.needsClarification) return { ...plan, queries: [] };
  const queries = (Array.isArray(plan.queries) ? plan.queries : []).slice(0, 3).map((query, index) => ({ id: String(query?.id || `q${index + 1}`), purpose: String(query?.purpose || "Business result"), sql: validateSql(query?.sql, cleanSchema) }));
  if (!queries.length) throw new Error("Assistant could not create a verified query for this question");
  return { title: String(plan.title || cleanQuestion).slice(0, 120), detailLevel: plan.detailLevel === "short" ? "short" : "detailed", needsClarification: false, clarification: "", queries, visualization: plan.visualization || { type: "none" } };
}

async function repairPlan({ question, failedSql, failure, history, schema, language, permissions }) {
  return createPlan({
    question: `${String(question || "")}\nThe previous safe read-only query failed locally. Repair it using exact schema only.\nFAILED SQL: ${String(failedSql || "").slice(0, 4000)}\nSQLITE ERROR: ${String(failure || "").slice(0, 1000)}`,
    history,
    schema,
    language, permissions,
  });
}

function normalizeFilters(filters) {
  const value = filters && typeof filters === "object" ? filters : {};
  return {
    fromDate: String(value.fromDate || "").slice(0, 10),
    toDate: String(value.toDate || "").slice(0, 10),
    branches: Array.isArray(value.branches) ? value.branches.map(String).slice(0, 100) : [],
    accounts: Array.isArray(value.accounts) ? value.accounts.map(String).slice(0, 100) : [],
    stores: Array.isArray(value.stores) ? value.stores.map(String).slice(0, 100) : [],
    products: value.products && typeof value.products === "object" ? value.products : {},
  };
}

async function createReportPlan({ code, filters, schema, language, permissions }) {
  const report = getReport(code);
  const cleanSchema = safeSchema(schema);
  if (!cleanSchema.length) throw Object.assign(new Error("Business resources are not ready"), { status: 409 });
  const cleanFilters = normalizeFilters(filters);
  const question = `Generate report ${report.id}: ${report.name}. Category: ${report.category}. Family: ${report.family}. Metrics: ${report.metrics.join(", ")}. Dimension: ${report.dimension || "overall"}. Analysis contract: ${report.analysisContract}. Advice intent: ${report.advice}. Apply exactly these filters: ${JSON.stringify(cleanFilters)}. Return both amount and quantity where relevant. Use readable names. For any sales fact, Pos and UnPos paid detail must both be included and de-duplicated by Branch + TransactionNumber. Use date(detailDate) for the complete inclusive filter range. Overall totals must cover the full filtered scope; LIMIT applies only to ranked detail.`;
  const plan = await createPlan({ question, history: [], schema: cleanSchema, language, permissions });
  return { report, filters: cleanFilters, plan };
}

async function explain({ question, plan, evidence, language }) {
  const safeEvidence = Array.isArray(evidence) ? evidence.slice(0, 3).map((item) => ({ id: String(item?.id || ""), purpose: String(item?.purpose || ""), rows: Array.isArray(item?.rows) ? item.rows.slice(0, 100) : [] })) : [];
  const system = `You are Cherry POS Business Assistant. Answer only from EVIDENCE produced by verified read-only queries. Never invent a number, percentage, trend, cause or forecast. If evidence is insufficient, say exactly what is missing. Match detailLevel. Even a short answer must be a polished natural sentence, format monetary amounts clearly as Rs, and mention the requested period. Use clear Roman Urdu/English matching the user. Include one useful observation or next action only when supported. Suggest up to 3 natural follow-up questions that can be answered from the same POS database. Do not output markdown tables. Return JSON only: {"answer":"...","highlights":["..."],"actions":["..."],"suggestions":["..."],"confidence":"high|medium|low"}.`;
  const content = await chat([{ role: "system", content: system }, { role: "user", content: `Language: ${String(language || "Roman Urdu")}\nQuestion: ${String(question || "").slice(0, 2000)}\nPlan: ${JSON.stringify({ title: plan?.title, detailLevel: plan?.detailLevel })}\nEVIDENCE: ${JSON.stringify(safeEvidence)}` }], { json: true, temperature: 0.2 });
  const result = extractJson(content);
  return { answer: String(result.answer || "Evidence se jawab prepare nahi ho saka."), highlights: Array.isArray(result.highlights) ? result.highlights.map(String).slice(0, 6) : [], actions: Array.isArray(result.actions) ? result.actions.map(String).slice(0, 5) : [], suggestions: Array.isArray(result.suggestions) ? result.suggestions.map(String).slice(0, 3) : [], confidence: ["high","medium","low"].includes(result.confidence) ? result.confidence : "medium" };
}

module.exports = { createPlan, createReportPlan, explain, repairPlan, validateSql, safeSchema };
