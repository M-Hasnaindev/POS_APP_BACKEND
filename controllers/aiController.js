const reportService = require("../services/reportService");
const aiLiveReportService = require("../services/aiLiveReportService");
const {
  generateReportNarrative,
  fallbackReportNarrative,
  answerAssistant,
} = require("../services/aiService");
const { checkOllama } = require("../services/ollamaService");
const {
  getCatalogForTenant,
  getOllamaHealth,
} = require("../services/openaiPosService");
const { resolveAiUserContext } = require("../services/aiUserScopeService");

exports.health = async (req, res) => {
  const [ollama, catalog] = await Promise.all([
    getOllamaHealth().catch(() => checkOllama()),
    getCatalogForTenant(req.user.tenantId, false),
  ]);
  return res.json({
    success: true,
    tenantId: req.user.tenantId,
    ollama,
    catalog: { generatedAt: catalog.generatedAt, tableCount: catalog.tables.length },
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
    .slice(-10)
    .map((item) => ({
      role: item.role,
      // Conversation can be unlimited on the phone; only a compact recent
      // window is sent to the model so message #20/#100 is not slower than #2.
      content: String(item.content || "").trim().slice(0, 700),
    }))
    .filter((item) => item.content);
}

exports.assistant = async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ success: false, message: "Message is required" });

    const history = compactAssistantHistory(req.body?.history);
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
