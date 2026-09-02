const reportService = require("../services/reportService");
const aiLiveReportService = require("../services/aiLiveReportService");
const { generateReportNarrative, answerAssistant } = require("../services/aiService");
const { checkOllama } = require("../services/ollamaService");

exports.health = async (req, res) => {
  const ollama = await checkOllama();
  return res.json({ success: true, tenantId: req.user.tenantId, ollama });
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
    const report = await aiLiveReportService.runReport({
      tenantId: req.user.tenantId,
      user: req.user,
      code: String(req.params.code || "").trim(),
      filters: req.body?.filters || {},
    });
    const narrative = req.body?.includeInsight === false
      ? null
      : await generateReportNarrative(report, String(req.body?.language || "English"));
    return res.json({ success: true, report: { ...report, narrative } });
  } catch (error) {
    console.error("AI REPORT RUN ERROR:", error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || "Unable to run report" });
  }
};

exports.assistant = async (req, res) => {
  try {
    const result = await answerAssistant({
      tenantId: req.user.tenantId,
      user: req.user,
      message: req.body?.message,
      history: req.body?.history,
    });
    return res.json({ success: true, result });
  } catch (error) {
    console.error("AI ASSISTANT ERROR:", error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || "Assistant is unavailable" });
  }
};
