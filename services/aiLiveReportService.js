const { sql, getPoolForTenant } = require("../config/db");
const aiConfig = require("../config/ai");
const reportCatalog = require("../ai/reportCatalog");
const {
  allowedTables,
  businessRules,
  tablePurposes,
  selectRelevantTables,
} = require("../ai/knowledge");
const { validateReadOnlySql } = require("../ai/sqlSafety");
const { ollamaChat } = require("./ollamaService");
const reportService = require("./reportService");
const { normalizeFilters } = reportService;

const FAMILY_TABLES = Object.freeze({
  management: [
    "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail",
    "PosPurchaseM", "PosPurchaseD", "PosTransferM", "PosTransferD",
    "BranchFile", "StockRoom", "BarcodeView", "AccountList", "Employee", "PosPayment", "UnPosPayment",
  ],
  sales: [
    "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail",
    "PosPayment", "UnPosPayment", "BranchFile", "StockRoom", "BarcodeView", "Employee",
  ],
  inventory: [
    "PosBarOpen", "PosPurchaseM", "PosPurchaseD", "PosPReturnM", "PosPReturnD",
    "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail",
    "PosTransferM", "PosTransferD", "PosStockAdjM", "PosStockAdjD",
    "PosStockTakeM", "PosStockTakeD", "BranchFile", "StockRoom", "BarcodeView",
  ],
  purchase: ["PosPurchaseM", "PosPurchaseD", "AccountList", "BranchFile", "StockRoom", "BarcodeView"],
  "purchase-return": ["PosPReturnM", "PosPReturnD", "AccountList", "BranchFile", "StockRoom", "BarcodeView"],
  transfer: ["PosTransferM", "PosTransferD", "BranchFile", "StockRoom", "BarcodeView"],
  product: ["BarcodeView", "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail", "BranchFile", "StockRoom"],
  pricing: ["BarcodeView", "PosDiscount", "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail", "BranchFile"],
  tax: ["PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail", "BranchFile", "BarcodeView"],
  target: [
    "PosBranchIncentive", "PosSalesmanIncentive", "PosCategoryIncentive",
    "PosCategoryWiseSalesmanIncentive", "PosTargetMaster", "PosTargetDetail",
    "BranchFile", "Employee", "BarcodeView",
    "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail",
  ],
});

const FILTER_CONFIG = Object.freeze({
  branches: { prefix: "branch", meaning: "branch code; normally match Branch or the report's source branch column" },
  stores: { prefix: "store", meaning: "stock room/store code; normally match StoreCode or the relevant store column" },
  barcodes: { prefix: "barcode", meaning: "barcode; match BarCode/Barcode" },
  accounts: { prefix: "account", meaning: "selected account/customer/supplier/payment account code; use the business-appropriate account column" },
  brands: { prefix: "brand", meaning: "BarcodeView.Brand" },
  categories: { prefix: "category", meaning: "BarcodeView.Catagory" },
  seasons: { prefix: "season", meaning: "BarcodeView.Season" },
  styles: { prefix: "style", meaning: "BarcodeView.Style" },
  colors: { prefix: "color", meaning: "BarcodeView.Color" },
  sizes: { prefix: "size", meaning: "BarcodeView.Size" },
  designs: { prefix: "design", meaning: "BarcodeView.DesignNo" },
  fabrics: { prefix: "fabric", meaning: "BarcodeView.Fabric" },
  departments: { prefix: "department", meaning: "BarcodeView.Department" },
  genders: { prefix: "gender", meaning: "BarcodeView.Gender" },
  cobrands: { prefix: "cobrand", meaning: "BarcodeView.CoBrand" },
  suppliers: { prefix: "supplier", meaning: "BarcodeView.CoBrandClass when this filter is used as merchandise supplier/class" },
  subcategories: { prefix: "subcategory", meaning: "BarcodeView.SubCatagory" },
  substyles: { prefix: "substyle", meaning: "BarcodeView.SubStyle" },
  styleclasses: { prefix: "styleclass", meaning: "BarcodeView.StyleClass" },
  styleclass1: { prefix: "styleclass1", meaning: "BarcodeView.SubStyle1Class" },
  styleclass2: { prefix: "styleclass2", meaning: "BarcodeView.SubStyle2Class" },
  subdepartments: { prefix: "subdepartment", meaning: "BarcodeView.SubDepartment" },
  fabricclasses: { prefix: "fabricclass", meaning: "BarcodeView.FabricClass" },
  colorclasses: { prefix: "colorclass", meaning: "BarcodeView.ColorClass" },
});

function selectTablesForReport(report) {
  // Small models are much more reliable when they only see the schema that is
  // relevant to the selected report. Infer the working set from the report
  // contract first, then fall back to the broader family map when needed.
  const intent = [
    report.name,
    report.category,
    report.family,
    report.dataRoute,
    ...(report.metrics || []),
  ].filter(Boolean).join(" ");
  const inferred = selectRelevantTables(intent);
  const inferredBusinessTables = inferred.filter((name) => !["BranchFile", "StockRoom", "BarcodeView"].includes(name));
  const base = inferredBusinessTables.length ? inferred : (FAMILY_TABLES[report.family] || inferred);
  const selected = new Set([...base, ...(report.requiredTables || [])]);
  return [...selected].filter((name) => allowedTables.includes(name));
}

async function getLiveTableMap(pool) {
  const result = await pool.request().query(
    "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' UNION SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS",
  );
  return new Map((result.recordset || []).map((row) => [String(row.TABLE_NAME).toLowerCase(), String(row.TABLE_NAME)]));
}

async function getSchema(pool, requestedTables) {
  const live = await getLiveTableMap(pool);
  const safe = requestedTables
    .map((name) => live.get(String(name).toLowerCase()))
    .filter(Boolean)
    .filter((name, index, array) => array.findIndex((x) => x.toLowerCase() === name.toLowerCase()) === index);

  if (!safe.length) return { tables: [], columnsByTable: {}, schemaText: "" };

  const request = pool.request();
  const params = safe.map((name, index) => {
    request.input(`schemaTable${index}`, sql.NVarChar(128), name);
    return `@schemaTable${index}`;
  });
  const result = await request.query(`
    SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,ORDINAL_POSITION
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME IN (${params.join(",")})
    ORDER BY TABLE_NAME,ORDINAL_POSITION
  `);

  const columnsByTable = {};
  for (const row of result.recordset || []) {
    (columnsByTable[row.TABLE_NAME] ||= []).push({
      name: String(row.COLUMN_NAME),
      type: String(row.DATA_TYPE),
    });
  }

  return {
    tables: Object.keys(columnsByTable),
    columnsByTable,
    schemaText: Object.entries(columnsByTable)
      .map(([name, columns]) => `${name}(${columns.map((column) => `${column.name}:${column.type}`).join(", ")})`)
      .join("\n"),
  };
}

function filterBindings(filters) {
  const bindings = [];
  for (const [filterKey, config] of Object.entries(FILTER_CONFIG)) {
    const values = Array.isArray(filters[filterKey]) ? filters[filterKey] : [];
    values.forEach((value, index) => {
      bindings.push({
        filterKey,
        meaning: config.meaning,
        name: `${config.prefix}${index}`,
        value: String(value),
      });
    });
  }
  return bindings;
}

function allowedParameterNames(bindings) {
  return new Set(["companycode", "fromdate", "todate", ...bindings.map((binding) => binding.name.toLowerCase())]);
}

function assertOnlyBoundParameters(query, bindings) {
  const allowed = allowedParameterNames(bindings);
  const used = [...String(query || "").matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const unknown = [...new Set(used.filter((name) => !allowed.has(name.toLowerCase())))];
  if (unknown.length) throw new Error(`AI query used unbound parameter(s): ${unknown.join(", ")}`);
}

function assertSelectedFiltersApplied(query, bindings) {
  const text = String(query || "");
  const missing = bindings
    .map((binding) => binding.name)
    .filter((name) => !new RegExp(`@${name}\\b`, "i").test(text));
  if (missing.length) throw new Error(`AI query ignored selected filter parameter(s): ${missing.join(", ")}`);
}

function usedTablesNeedCompanyIsolation(query, schema, tables) {
  const byLower = new Map(Object.entries(schema.columnsByTable).map(([name, cols]) => [name.toLowerCase(), cols]));
  return tables.some((table) => (byLower.get(String(table).toLowerCase()) || []).some((column) => column.name.toLowerCase() === "companycode"));
}

function validateGeneratedQuery(query, schema, bindings) {
  const validation = validateReadOnlySql(query, schema.tables);
  assertOnlyBoundParameters(validation.sql, bindings);
  assertSelectedFiltersApplied(validation.sql, bindings);
  if (usedTablesNeedCompanyIsolation(validation.sql, schema, validation.tables) && !/@companyCode\b/i.test(validation.sql)) {
    throw new Error("AI query was blocked because CompanyCode tenant isolation was missing");
  }
  return validation.sql;
}

function createRequest(pool, user, filters, bindings) {
  const request = pool.request();
  request.timeout = aiConfig.sqlTimeoutMs;
  request.input("companyCode", sql.VarChar(20), String(user.companyCode || ""));
  request.input("fromDate", sql.Date, filters.fromDate);
  request.input("toDate", sql.Date, filters.toDate);
  for (const binding of bindings) request.input(binding.name, sql.NVarChar(220), binding.value);
  return request;
}

async function executeQuery(pool, user, filters, bindings, query, maxRows = aiConfig.maxRows) {
  const request = createRequest(pool, user, filters, bindings);
  const result = await request.query(query);
  return (result.recordset || []).slice(0, maxRows);
}

function selectedFilterPrompt(bindings) {
  if (!bindings.length) return "No optional business filters are selected. Do not invent any.";
  const grouped = {};
  for (const binding of bindings) (grouped[binding.filterKey] ||= []).push(`@${binding.name}`);
  return Object.entries(grouped).map(([key, params]) => {
    const config = FILTER_CONFIG[key];
    return `${key}: ${params.join(", ")} (${config?.meaning || key})`;
  }).join("\n");
}

function metricContract(report) {
  const keys = Array.isArray(report.metricKeys) && report.metricKeys.length ? report.metricKeys : ["Amount", "Quantity"];
  const labels = Array.isArray(report.metrics) && report.metrics.length ? report.metrics : keys;
  return keys.map((key, index) => `${key} = ${labels[index] || key}`).join("\n");
}

function compactSchemaText(schema, report, bindings) {
  const reportWords = [
    report.name,
    report.category,
    report.dataRoute,
    ...(report.metrics || []),
    ...bindings.map((binding) => binding.meaning),
  ].join(" ").toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 4);
  const reportWordSet = new Set(reportWords);
  const coreColumn = /(company|tran|date|branch|store|barcode|design|qty|quantity|amount|value|price|cost|profit|disc|discount|tax|gst|cancel|status|bill|account|party|customer|supplier|salesman|employee|name|code|receive|recqty|entrytype|stock|opening|target|incentive|brand|catagory|category|style|season|size|color|fabric|department|gender)/i;
  return Object.entries(schema.columnsByTable).map(([table, columns]) => {
    let picked = columns.filter((column) => {
      const lower = column.name.toLowerCase();
      return coreColumn.test(column.name) || [...reportWordSet].some((word) => lower.includes(word));
    });
    if (picked.length < 12) picked = columns.slice(0, 40);
    else picked = picked.slice(0, 60);
    return `${table}(${picked.map((column) => `${column.name}:${column.type}`).join(", ")})`;
  }).join("\n");
}

function commonPlannerPrompt(report, schema, bindings) {
  const purposes = Object.entries(tablePurposes)
    .filter(([name]) => schema.tables.some((table) => table.toLowerCase() === name.toLowerCase()))
    .map(([name, purpose]) => `${name}: ${purpose}`)
    .join("\n");

  return `You are Cherry AI's SQL planner for Microsoft SQL Server 2014. The backend already opened ONE authenticated tenant database. Generate SQL only from the supplied LIVE schema.

STRICT RULES:
1. One read-only SELECT or WITH...SELECT only. No semicolon, comments, SELECT *, temp tables, variables, EXEC, DML or DDL.
2. Never invent a table, column, join, status or business rule that is absent from LIVE SCHEMA / BUSINESS RULES.
3. Use only supplied named parameters. Never hard-code selected filter values or company code.
4. For period reports use @fromDate and @toDate; inclusive end-date pattern is < DATEADD(day,1,@toDate).
5. Every used table exposing CompanyCode must be isolated with @companyCode. Join CompanyCode between related header/detail transaction tables when both expose it.
6. Apply EVERY selected optional parameter to the appropriate business column.
7. Paid POS sales: matching master BillStatus='P', detail Cancel<>'Y', signed returns, and paid UnPos deduplicated against paid Pos.
8. Prefer readable business names when the live schema supports them.
9. If required data cannot be obtained from the live schema without guessing, return clarify rather than inventing SQL.

REPORT:
Code: ${report.code}
Name: ${report.name}
Family: ${report.family}
Dimension: ${report.dimension || "summary"}
Metrics:\n${metricContract(report)}
Route hint: ${report.dataRoute || "Use live schema and rules"}
Analysis contract: ${report.analysisContract || "Use exact live figures"}

BUSINESS RULES:\n${businessRules.join("\n")}

TABLE PURPOSES:\n${purposes || "Use the live schema."}

PARAMETERS:
@companyCode authenticated company isolation
@fromDate selected start date
@toDate selected end date
${selectedFilterPrompt(bindings)}

LIVE SCHEMA (authoritative, compacted to relevant columns):\n${compactSchemaText(schema, report, bindings)}`;
}

function targetPlannerPrompt(report, target) {
  const contract = metricContract(report);
  if (target === "summary") {
    return `TARGET: SUMMARY SQL.
Return EXACTLY one aggregate row. The returned columns MUST use these exact aliases:\n${contract}
Use COALESCE so no activity returns numeric 0. Do not return a Label column unless required internally.`;
  }
  return `TARGET: DETAIL SQL.
Return a useful management breakdown/ranking/trend with a readable first business dimension aliased exactly Label.
Return the applicable metric aliases from this contract where meaningful:\n${contract}
Use TOP ${aiConfig.maxRows} for non-time aggregate rankings. Keep the query focused and reasonably short.`;
}

function planKeys(value) {
  return value && typeof value === "object" ? Object.keys(value).slice(0, 12).join(",") : typeof value;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim()) || "";
}

function normalizeSinglePlan(plan, target) {
  if (typeof plan === "string" && /^(select|with)\b/i.test(plan.trim())) {
    return { mode: "sql", sql: plan.trim(), reason: "" };
  }
  const nested = plan?.plan && typeof plan.plan === "object" ? plan.plan : {};
  const modeRaw = firstString(plan?.mode, nested?.mode).toLowerCase();
  const reason = firstString(plan?.reason, nested?.reason, plan?.question, nested?.question);
  const targetCamel = target === "summary" ? "summarySql" : "detailSql";
  const targetSnake = target === "summary" ? "summary_sql" : "detail_sql";
  const targetQuery = target === "summary" ? "summaryQuery" : "detailQuery";
  const targetQuerySnake = target === "summary" ? "summary_query" : "detail_query";
  const sqlText = firstString(
    plan?.sql,
    plan?.query,
    plan?.[targetCamel],
    plan?.[targetSnake],
    plan?.[targetQuery],
    plan?.[targetQuerySnake],
    typeof plan?.[target] === "string" ? plan[target] : "",
    nested?.sql,
    nested?.query,
    nested?.[targetCamel],
    nested?.[targetSnake],
    nested?.[targetQuery],
    nested?.[targetQuerySnake],
  ).trim();
  const mode = modeRaw || (sqlText ? "sql" : "");
  if (mode === "clarify") return { mode, reason: reason || "Required live source is missing" };
  if (mode !== "sql" || !sqlText) {
    throw new Error(`Ollama returned an incomplete ${target} SQL plan (keys: ${planKeys(plan)})`);
  }
  return { mode: "sql", sql: sqlText, reason };
}

function extractRawSql(text) {
  let value = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fenced = value.match(/```(?:sql)?\s*([\s\S]*?)```/i);
  if (fenced) value = fenced[1].trim();
  const start = value.search(/\b(?:WITH|SELECT)\b/i);
  if (start > 0) value = value.slice(start);
  value = value.replace(/```[\s\S]*$/g, "").trim().replace(/;+\s*$/, "").trim();
  if (!/^(select|with)\b/i.test(value)) throw new Error("Ollama did not return SQL text");
  return value;
}

async function createSqlForTarget(report, schema, bindings, target, repairContext = null) {
  const common = commonPlannerPrompt(report, schema, bindings);
  const targetPrompt = targetPlannerPrompt(report, target);
  const repair = repairContext
    ? `\nREPAIR REQUIRED. Previous ${target} query failed. Fix it using ONLY this same live schema.\nFailure: ${String(repairContext.error || "").slice(0, 1200)}\nPrevious SQL: ${String(repairContext.sql || "").slice(0, 7000)}`
    : "";

  // First choice: small JSON object with only ONE SQL query. qwen3:1.7b is
  // materially more reliable with this than with two long SQL strings in one JSON.
  try {
    const response = await ollamaChat([
      { role: "system", content: `${common}\n\n${targetPrompt}` },
      { role: "user", content: `Return JSON only: {"mode":"sql|clarify","sql":"","reason":""}.${repair}` },
    ], { json: true, temperature: 0 });
    return normalizeSinglePlan(response, target);
  } catch (jsonError) {
    // Some small local models still produce malformed/odd JSON despite format=json.
    // Retry once in raw-SQL mode; SQL safety/parameter validation still runs later.
    const raw = await ollamaChat([
      { role: "system", content: `${common}\n\n${targetPrompt}\nReturn ONLY the SQL query text. No JSON, markdown, explanation or comments.` },
      { role: "user", content: `Generate the ${target} SQL now.${repair}` },
    ], { json: false, temperature: 0 });
    return { mode: "sql", sql: extractRawSql(raw), reason: `JSON planner fallback: ${safeErrorMessage(jsonError)}` };
  }
}

async function createPlan(report, schema, bindings, repairContext = null) {
  const summary = await createSqlForTarget(report, schema, bindings, "summary", repairContext ? {
    error: repairContext.error,
    sql: repairContext.plan?.summarySql || "",
  } : null);
  if (summary.mode === "clarify") return summary;

  const detail = await createSqlForTarget(report, schema, bindings, "detail", repairContext ? {
    error: repairContext.error,
    sql: repairContext.plan?.detailSql || "",
  } : null);
  if (detail.mode === "clarify") return detail;

  return {
    mode: "sql",
    summarySql: summary.sql,
    detailSql: detail.sql,
    reason: [summary.reason, detail.reason].filter(Boolean).join(" | "),
  };
}

function formatForMetric(label, key) {
  const text = `${label} ${key}`.toLowerCase();
  if (/%|percent|margin|growth|rate|share|performance/.test(text)) return "percent";
  if (/amount|sales|revenue|value|profit|cost|purchase|discount|tax|gst|bill value|average bill|avg bill|payable|receivable/.test(text)) return "currency";
  return "number";
}

function valueCaseInsensitive(row, key) {
  if (!row) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const actual = Object.keys(row).find((name) => name.toLowerCase() === String(key).toLowerCase());
  return actual ? row[actual] : undefined;
}

function buildKpis(report, summaryRow) {
  const keys = Array.isArray(report.metricKeys) && report.metricKeys.length ? report.metricKeys : ["Amount", "Quantity"];
  const labels = Array.isArray(report.metrics) && report.metrics.length ? report.metrics : keys;
  return keys.map((key, index) => ({
    key,
    label: labels[index] || key,
    format: formatForMetric(labels[index] || key, key),
    value: Number(valueCaseInsensitive(summaryRow, key) || 0),
  }));
}

function normalizeDetailRows(rows, report) {
  return (rows || []).map((row, index) => {
    if (valueCaseInsensitive(row, "Label") !== undefined) return row;
    const entries = Object.entries(row);
    const labelEntry = entries.find(([, value]) => typeof value === "string" || value instanceof Date);
    return { Label: labelEntry ? String(labelEntry[1] ?? "") : `Row ${index + 1}`, ...row };
  });
}

function buildCharts(report, rows) {
  if (!rows.length) return [];
  const metricKeys = Array.isArray(report.metricKeys) && report.metricKeys.length ? report.metricKeys : ["Amount", "Quantity"];
  const metricLabels = Array.isArray(report.metrics) ? report.metrics : metricKeys;
  const primaryKey = metricKeys[0] || "Amount";
  const quantityIndex = metricLabels.findIndex((label) => /qty|quantity|count|units/i.test(String(label)));
  const secondaryKey = quantityIndex >= 0 ? metricKeys[quantityIndex] : metricKeys[1];
  const data = rows.slice(0, 30).map((row, index) => ({
    ...row,
    Label: String(valueCaseInsensitive(row, "Label") ?? `Row ${index + 1}`),
    Amount: Number(valueCaseInsensitive(row, "Amount") ?? valueCaseInsensitive(row, primaryKey) ?? 0),
    Quantity: Number(valueCaseInsensitive(row, "Quantity") ?? (secondaryKey ? valueCaseInsensitive(row, secondaryKey) : 0) ?? 0),
  }));
  if (!data.some((row) => Number.isFinite(row.Amount) || Number.isFinite(row.Quantity))) return [];
  return [{
    type: ["bar", "line", "pie"].includes(report.chartType) ? report.chartType : "bar",
    title: report.name,
    data,
  }];
}

async function executePlan({ pool, user, filters, bindings, schema, plan, report }) {
  const summarySql = validateGeneratedQuery(plan.summarySql, schema, bindings);
  const detailSql = validateGeneratedQuery(plan.detailSql, schema, bindings);
  const [summaryRows, detailRows] = await Promise.all([
    executeQuery(pool, user, filters, bindings, summarySql, 5),
    executeQuery(pool, user, filters, bindings, detailSql, aiConfig.maxRows),
  ]);
  if (summaryRows.length !== 1) throw new Error(`Summary SQL must return exactly one row; returned ${summaryRows.length}`);
  const expectedKeys = Array.isArray(report.metricKeys) ? report.metricKeys : [];
  const missingKeys = expectedKeys.filter((key) => valueCaseInsensitive(summaryRows[0], key) === undefined);
  if (missingKeys.length) throw new Error(`Summary SQL is missing required metric alias(es): ${missingKeys.join(", ")}`);
  return { summaryRows, detailRows, summarySql, detailSql };
}

function safeErrorMessage(error) {
  const text = String(error?.message || error || "Unknown SQL planner error");
  return text.replace(/password\s*=\s*[^;\s]+/gi, "password=[redacted]").slice(0, 1600);
}

async function runDeterministicFallback({ tenantId, user, code, filters, plannerError }) {
  try {
    const fallback = await reportService.runReport({ tenantId, user, code, filters });
    return {
      ...fallback,
      source: "live-database",
      executionMode: "live-sql-fallback",
      note: `Live MSSQL report completed through the verified backend query engine because the local Ollama model could not produce a valid SQL plan (${safeErrorMessage(plannerError)}). Figures are still read from the authenticated tenant database; Ollama is used for the management narrative.`,
      debug: process.env.AI_INCLUDE_SQL_DEBUG === "true" ? {
        fallback: true,
        plannerError: safeErrorMessage(plannerError),
      } : undefined,
    };
  } catch (fallbackError) {
    const error = new Error(`Ollama SQL planner failed and the live-query fallback also failed. Planner: ${safeErrorMessage(plannerError)} | Fallback: ${safeErrorMessage(fallbackError)}`);
    error.status = fallbackError.status || 503;
    throw error;
  }
}

async function listReports(tenantId) {
  const pool = await getPoolForTenant(tenantId);
  const live = await getLiveTableMap(pool);
  return reportCatalog.map((report) => {
    const requested = selectTablesForReport(report);
    const existing = requested.filter((table) => live.has(table.toLowerCase()));
    const missingRequired = (report.requiredTables || []).filter((table) => !live.has(table.toLowerCase()));
    const available = !missingRequired.length && existing.length > 0;
    return {
      ...report,
      available,
      unavailableReason: available ? null : `Required live source is not available${missingRequired.length ? `: ${missingRequired.join(", ")}` : ""}.`,
      executionMode: "ollama-live-sql",
    };
  });
}

async function runReport({ tenantId, user, code, filters: input }) {
  const report = reportCatalog.find((item) => item.code === code);
  if (!report) throw Object.assign(new Error("Unknown report code"), { status: 404 });

  const pool = await getPoolForTenant(tenantId);
  const filters = normalizeFilters(input);
  const requestedTables = selectTablesForReport(report);
  const schema = await getSchema(pool, requestedTables);
  const missingRequired = (report.requiredTables || []).filter((table) => !schema.tables.some((live) => live.toLowerCase() === table.toLowerCase()));
  if (missingRequired.length) {
    throw Object.assign(new Error(`Report source unavailable: ${missingRequired.join(", ")}`), { status: 422 });
  }
  if (!schema.tables.length) {
    throw Object.assign(new Error("No supported live database tables were found for this report"), { status: 422 });
  }

  const bindings = filterBindings(filters);
  let plan;
  try {
    plan = await createPlan(report, schema, bindings);
  } catch (plannerError) {
    const firstPlannerMessage = safeErrorMessage(plannerError);
    console.warn(`AI REPORT PLAN FIRST ATTEMPT FAILED [${report.code}]:`, firstPlannerMessage);
    try {
      plan = await createPlan(report, schema, bindings, { error: firstPlannerMessage, plan: {} });
    } catch (retryError) {
      console.warn(`AI REPORT PLAN SECOND ATTEMPT FAILED [${report.code}]:`, safeErrorMessage(retryError));
      return runDeterministicFallback({
        tenantId,
        user,
        code,
        filters,
        plannerError: retryError,
      });
    }
  }
  if (plan.mode === "clarify") throw Object.assign(new Error(plan.reason), { status: 422 });

  let executed;
  let repaired = false;
  try {
    executed = await executePlan({ pool, user, filters, bindings, schema, plan, report });
  } catch (firstError) {
    const firstMessage = safeErrorMessage(firstError);
    console.warn(`AI REPORT SQL FIRST ATTEMPT FAILED [${report.code}]:`, firstMessage);
    plan = await createPlan(report, schema, bindings, { error: firstMessage, plan });
    if (plan.mode === "clarify") throw Object.assign(new Error(plan.reason), { status: 422 });
    try {
      executed = await executePlan({ pool, user, filters, bindings, schema, plan, report });
      repaired = true;
    } catch (secondError) {
      console.warn(`AI REPORT SQL SECOND ATTEMPT FAILED [${report.code}]:`, safeErrorMessage(secondError));
      return runDeterministicFallback({
        tenantId,
        user,
        code,
        filters,
        plannerError: secondError,
      });
    }
  }

  const summaryRow = executed.summaryRows[0] || {};
  const rows = normalizeDetailRows(executed.detailRows, report);
  const hasAnyValue = Object.values(summaryRow).some((value) => typeof value === "number" ? value !== 0 : value != null && String(value) !== "");

  return {
    title: report.name,
    code: report.code,
    category: report.category,
    uiVariant: report.uiVariant,
    family: report.family,
    mode: report.mode,
    descriptionLines: report.descriptionLines,
    filters,
    kpis: buildKpis(report, summaryRow),
    charts: buildCharts(report, rows),
    rows,
    source: "live-database",
    executionMode: "ollama-live-sql",
    generatedAt: new Date().toISOString(),
    note: rows.length || hasAnyValue
      ? `Cherry AI generated read-only SQL from the authenticated tenant's live schema${repaired ? " and automatically repaired the first invalid plan" : ""}. Numeric figures are returned by MSSQL; AI does not invent them.`
      : "The live query executed successfully but no matching data was found for the selected scope.",
    debug: process.env.AI_INCLUDE_SQL_DEBUG === "true" ? {
      tables: schema.tables,
      summarySql: executed.summarySql,
      detailSql: executed.detailSql,
      repaired,
    } : undefined,
  };
}

module.exports = {
  listReports,
  runReport,
  selectTablesForReport,
  getSchema,
  filterBindings,
};
