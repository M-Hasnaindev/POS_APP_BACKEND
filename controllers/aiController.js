const reportService = require("../services/reportService");
const aiLiveReportService = require("../services/aiLiveReportService");
const {
  generateReportNarrative,
  fallbackReportNarrative,
  answerAssistant,
} = require("../services/aiService");
const { checkOllama, getOllamaRuntimeState } = require("../services/ollamaService");
const {
  getCatalogForTenant,
  getOllamaHealth,
} = require("../services/openaiPosService");
const { resolveAiUserContext } = require("../services/aiUserScopeService");
const { getQuestionBankStats } = require("../ai/questionBankTraining");
const { getIntentIndexStats } = require("../ai/trainingSemanticRouter");

exports.health = async (req, res) => {
  const [ollama, catalog] = await Promise.all([
    getOllamaHealth().catch(() => checkOllama()),
    getCatalogForTenant(req.user.tenantId, false),
  ]);
  return res.json({
    success: true,
    tenantId: req.user.tenantId,
    ollama: { ...ollama, runtime: getOllamaRuntimeState() },
    catalog: { generatedAt: catalog.generatedAt, tableCount: catalog.tables.length },
    assistantTraining: {
      ...getQuestionBankStats(),
      semanticIntentIndex: getIntentIndexStats(),
    },
    assistantSafety: {
      policy: "10k-intent-vote -> explicit-intent-cross-check -> verified-live-sql -> clarify-not-guess",
      plannerMinimumConfidence: 0.82,
      semanticRouteMinimumConfidence: 0.62,
      semanticAmbiguityGuard: true,
      exactLiveNumbersOnly: true,
    },
  });
};

exports.catalog = async (req, res) => {
  try {
    const force = /^(1|true|yes)$/i.test(String(req.query.refresh || ""));
    const catalog = await getCatalogForTenant(req.user.tenantId, force);
    return res.json({
      success: true,
      tenantId: req.user.tenantId,
      generatedAt: catalog.generatedAt,
      tableCount: catalog.tables.length,
      tables: catalog.tables.map((table) => ({
        schema: table.schema,
        name: table.name,
        objectType: table.objectType,
        estimatedRows: table.estimatedRows,
        columnCount: table.columns.length,
      })),
    });
  } catch (error) {
    console.error("AI DATABASE CATALOG ERROR:", error.message);
    return res.status(500).json({ success: false, message: "Unable to read live database catalog" });
  }
};

exports.listReports = async (req, res) => {
  try {
    const reports = await aiLiveReportService.listReports(req.user.tenantId);
    return res.json({ success: true, reports, count: reports.length });
  } catch (error) {
    console.error("AI REPORT CATALOG ERROR:", error.message);
    return res.status(500).json({ success: false, message: "Unable to load AI reports" });
  }
};

exports.filterOptions = async (req,res)=>{
  try{
    const options=await reportService.listFilterOptions({tenantId:req.user.tenantId,user:req.user,kind:String(req.query.kind||""),query:String(req.query.q||""),branches:String(req.query.branches||"").split(",").filter(Boolean)});
    return res.json({success:true,options,count:options.length});
  }catch(error){return res.status(error.status||500).json({success:false,message:error.message||"Unable to load filters"});}
};

exports.runReport = async (req, res) => {
  try {
    // The 460 catalog reports already have verified, detail-first SQL engines.
    // Do not put two Ollama SQL-planning calls in the critical HTTP path: on a
    // CPU-hosted local model that can take minutes and the tunnel/proxy returns
    // 504 before any live figures reach the app. The opt-in planner remains
    // available for development, while production defaults to deterministic
    // tenant-isolated SQL and uses Ollama only for the narrative.
    const reportEngine = process.env.AI_REPORT_SQL_MODE === "ollama"
      ? aiLiveReportService
      : reportService;
    const report = await reportEngine.runReport({
      tenantId: req.user.tenantId,
      user: req.user,
      code: String(req.params.code || "").trim(),
      filters: req.body?.filters || {},
    });
    // Return exact live figures immediately. Ollama insight is requested by the
    // result screen through the separate endpoint below, so a cold/busy local
    // model can never turn a successful SQL report into a gateway 504.
    const narrative = req.body?.includeInsight === false
      ? null
      : fallbackReportNarrative(report);
    return res.json({
      success: true,
      report: {
        ...report,
        executionMode: report.executionMode || "verified-live-sql",
        narrative,
      },
    });
  } catch (error) {
    console.error("AI REPORT RUN ERROR:", error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || "Unable to run report" });
  }
};

exports.reportInsight = async (req, res) => {
  try {
    const report = req.body?.report;
    const code = String(req.params.code || "").trim();
    if (!report || String(report.code || "") !== code) {
      return res.status(400).json({ success: false, message: "Matching report data is required" });
    }
    const narrative = await generateReportNarrative(
      {
        code,
        title: String(report.title || ""),
        filters: report.filters || {},
        kpis: Array.isArray(report.kpis) ? report.kpis.slice(0, 20) : [],
        rows: Array.isArray(report.rows) ? report.rows.slice(0, 12) : [],
        note: String(report.note || ""),
      },
      String(req.body?.language || "English"),
    );
    return res.json({ success: true, narrative });
  } catch (error) {
    console.error("AI REPORT INSIGHT ERROR:", error.message);
    return res.status(500).json({ success: false, message: "AI insight is temporarily unavailable" });
  }
};

function compactAssistantHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && (item.role === "user" || item.role === "assistant"))
    .slice(-24)
    .map((item) => ({
      role: item.role,
      // Keep enough natural-language context for pronouns and chained follow-ups.
      // Long-lived factual scope is carried separately in structured memory, so
      // the model never needs the whole conversation dumped into every request.
      content: String(item.content || "").trim().slice(0, 1200),
    }))
    .filter((item) => item.content);
}

function compactAssistantMemory(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const asList = (input, max = 30) => Array.isArray(input)
    ? input.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, max)
    : [];
  const filters = value.filters && typeof value.filters === "object" ? value.filters : {};
  const safeFilters = {
    fromDate: String(filters.fromDate || "").slice(0, 10),
    toDate: String(filters.toDate || "").slice(0, 10),
    branches: asList(filters.branches),
    stores: asList(filters.stores),
    accounts: asList(filters.accounts),
    barcodes: asList(filters.barcodes),
    brands: asList(filters.brands || filters.brand),
    categories: asList(filters.categories || filters.category),
    suppliers: asList(filters.suppliers || filters.supplier),
    designs: asList(filters.designs || filters.design),
    colors: asList(filters.colors || filters.color),
    sizes: asList(filters.sizes || filters.size),
    seasons: asList(filters.seasons),
    styles: asList(filters.styles),
    fabrics: asList(filters.fabrics),
    departments: asList(filters.departments),
    genders: asList(filters.genders),
    cobrands: asList(filters.cobrands),
    subcategories: asList(filters.subcategories),
    substyles: asList(filters.substyles),
    styleclasses: asList(filters.styleclasses),
    styleclass1: asList(filters.styleclass1),
    styleclass2: asList(filters.styleclass2),
    subdepartments: asList(filters.subdepartments),
    fabricclasses: asList(filters.fabricclasses),
    colorclasses: asList(filters.colorclasses),
  };
  const trail = Array.isArray(value.turns) ? value.turns.slice(-20).map((turn) => ({
    question: String(turn?.question || "").slice(0, 700),
    resolvedQuestion: String(turn?.resolvedQuestion || "").slice(0, 1200),
    answerSummary: String(turn?.answerSummary || "").slice(0, 1400),
    keyPoints: asList(turn?.keyPoints, 8).map((item) => item.slice(0, 500)),
    metrics: Array.isArray(turn?.metrics) ? turn.metrics.slice(0, 10).map((item) => ({
      key: String(item?.key || "").slice(0, 80),
      label: String(item?.label || "").slice(0, 120),
      format: String(item?.format || "number").slice(0, 30),
      value: Number(item?.value || 0),
    })) : [],
    scope: String(turn?.scope || "").slice(0, 500),
    route: String(turn?.route || "").slice(0, 160),
    domain: String(turn?.domain || "").slice(0, 80),
    dimension: String(turn?.dimension || "").slice(0, 80),
    filters: turn?.filters && typeof turn.filters === "object" ? {
      fromDate: String(turn.filters.fromDate || "").slice(0, 10),
      toDate: String(turn.filters.toDate || "").slice(0, 10),
      branches: asList(turn.filters.branches, 15),
      stores: asList(turn.filters.stores, 15),
      accounts: asList(turn.filters.accounts, 15),
      barcodes: asList(turn.filters.barcodes, 15),
      brands: asList(turn.filters.brands, 15),
      categories: asList(turn.filters.categories, 15),
      suppliers: asList(turn.filters.suppliers, 15),
      designs: asList(turn.filters.designs, 15),
    } : {},
  })) : [];
  return {
    version: 3,
    anchorQuestion: String(value.anchorQuestion || "").slice(0, 1200),
    resolvedQuestion: String(value.resolvedQuestion || "").slice(0, 1600),
    domain: String(value.domain || "").slice(0, 80),
    dimension: String(value.dimension || "").slice(0, 80),
    route: String(value.route || "").slice(0, 160),
    filters: safeFilters,
    turns: trail,
  };
}

exports.assistant = async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ success: false, message: "Message is required" });

    const history = compactAssistantHistory(req.body?.history);
    const memory = compactAssistantMemory(req.body?.memory);
    const languageMode = String(req.body?.language || "english-roman");
    const aiUser = await resolveAiUserContext({ tenantId: req.user.tenantId, user: req.user });

    // IMPORTANT: keep every chat turn on one stable request path. Previously
    // simple question #1 used verified SQL, while a conversational question #2
    // could jump into a multi-round Ollama tool-agent + chunked heartbeat path.
    // That path was vulnerable to proxy/mobile timeouts. answerAssistant keeps
    // common POS intents deterministic and bounds the optional model fallback.
    const result = await answerAssistant({
      tenantId: req.user.tenantId,
      user: aiUser,
      message,
      history,
      memory,
      languageMode,
    });

    return res.json({
      success: true,
      result: {
        ...result,
        dataSource: { type: "LIVE_MSSQL", tenantId: req.user.tenantId },
      },
    });
  } catch (error) {
    console.error("AI ASSISTANT ERROR:", error.message);
    return res.status(error.status || 500).json({
      success: false,
      message: error.publicMessage || error.message || "Assistant is unavailable",
    });
  }
};
