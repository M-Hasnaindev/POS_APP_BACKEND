const service = require("../services/intelligenceService");
const { getBranchPriceAccess } = require("../services/branchPriceAccessService");

async function bodyWithPermissions(req){
  const access=await getBranchPriceAccess({tenantId:req.user.tenantId,userId:req.user.userId,companyCode:req.user.companyCode});
  return {...(req.body||{}),permissions:{isAdmin:access.isAdmin,allowRetail:access.allowRetail,allowWholesale:access.allowWholesale,branches:access.branches.map((item)=>item.BranchCode||item.branchCode).filter(Boolean)}};
}

exports.plan = async (req, res) => {
  try { return res.json({ success: true, plan: await service.createPlan(await bodyWithPermissions(req)) }); }
  catch (error) { console.error("ASSISTANT PLAN ERROR:", error.message); return res.status(error.status || 500).json({ success: false, message: error.message || "Unable to plan this question" }); }
};

exports.explain = async (req, res) => {
  try { return res.json({ success: true, result: await service.explain(req.body || {}) }); }
  catch (error) { console.error("ASSISTANT EXPLAIN ERROR:", error.message); return res.status(error.status || 500).json({ success: false, message: error.message || "Unable to explain this result" }); }
};

exports.repair = async (req, res) => {
  try { return res.json({ success: true, plan: await service.repairPlan(await bodyWithPermissions(req)) }); }
  catch (error) { console.error("ASSISTANT REPAIR ERROR:", error.message); return res.status(error.status || 500).json({ success: false, message: error.message || "Unable to repair this query" }); }
};

exports.catalog = (_req, res) => {
  const value = require("../services/businessCatalogService").listReports();
  return res.json({ success: true, ...value });
};

exports.reportPlan = async (req, res) => {
  try { return res.json({ success: true, ...(await service.createReportPlan(await bodyWithPermissions(req))) }); }
  catch (error) { console.error("REPORT PLAN ERROR:", error.message); return res.status(error.status || 500).json({ success: false, message: error.message || "Unable to generate this report" }); }
};
