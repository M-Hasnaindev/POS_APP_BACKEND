const { getManifest, getResourceChanges, getResourcePage } = require("../services/knowledgeResourceService");
const { getBranchPriceAccess } = require("../services/branchPriceAccessService");
const { buildDeltaSnapshot, readDeltaSnapshot } = require("../services/knowledgeResourceService");

exports.buildSnapshot = async (req,res) => {
  try { return res.json({success:true,...await buildDeltaSnapshot({tenantId:req.user.tenantId,companyCode:req.user.companyCode,...await scope(req),tableName:req.params.table})}); }
  catch(error){return res.status(error.status||500).json({success:false,message:error.message});}
};
exports.snapshotChanges = async (req,res) => {
  try { return res.json({success:true,...await readDeltaSnapshot({tenantId:req.user.tenantId,companyCode:req.user.companyCode,...await scope(req),tableName:req.params.table,version:req.query.version,previous:req.query.previous,cursor:req.query.cursor})}); }
  catch(error){return res.status(error.status||500).json({success:false,message:error.message});}
};

async function scope(req){const access=await getBranchPriceAccess({tenantId:req.user.tenantId,userId:req.user.userId,companyCode:req.user.companyCode});return{allowedBranches:access.branches.map(item=>item.BranchCode),isAdmin:access.isAdmin}}

exports.manifest = async (req, res) => {
  try {
    const data = await getManifest({
      tenantId: req.user.tenantId,
      companyCode: req.user.companyCode,
      ...(await scope(req)),
      force: /^(1|true|yes)$/i.test(String(req.query.refresh || "")),
    });
    return res.json({ success: true, tenantId: req.user.tenantId, ...data });
  } catch (error) {
    console.error("RESOURCE MANIFEST ERROR:", error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || "Unable to prepare resources" });
  }
};

exports.changes = async (req, res) => {
  try { return res.json({ success: true, ...(await getResourceChanges({ tenantId:req.user.tenantId, companyCode:req.user.companyCode, ...(await scope(req)), tableName:req.params.table, watermark:req.query.watermark, fingerprint:req.query.fingerprint })) }); }
  catch (error) { console.error("RESOURCE CHANGES ERROR:", error.message); return res.status(error.status || 500).json({ success:false,message:error.message || "Unable to read resource changes" }); }
};

exports.page = async (req, res) => {
  try {
    const data = await getResourcePage({
      tenantId: req.user.tenantId,
      companyCode: req.user.companyCode,
      ...(await scope(req)),
      tableName: req.params.table,
      page: req.query.page,
      pageSize: req.query.pageSize,
      rowOffset: req.query.offset,
    });
    return res.json({ success: true, tenantId: req.user.tenantId, ...data });
  } catch (error) {
    console.error("RESOURCE PAGE ERROR:", error.message);
    return res.status(error.status || 500).json({ success: false, message: error.message || "Unable to download resource" });
  }
};
