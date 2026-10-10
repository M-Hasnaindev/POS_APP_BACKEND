const {getPoolForTenant}=require('../config/db');
const {resolveAuthenticatedCompanyCode}=require('../services/accountingService');
const {executeAccountingReport}=require('../services/accountingReports');
exports.generateAccountingReport=async(req,res)=>{
 try{
  const tenantId=String(req.user?.tenantId||'').trim(),userId=String(req.user?.userId||'').trim();
  if(!tenantId||!userId)return res.status(401).json({success:false,message:'Please sign in again'});
  const pool=await getPoolForTenant(tenantId);
  const companyCode=await resolveAuthenticatedCompanyCode(pool,userId,req.user?.companyCode,req.headers['x-company-code']);
  const result=await executeAccountingReport(pool,{tenantId,userId,companyCode},req.body?.reportId,req.body?.filters);
  return res.json({success:true,...result});
 }catch(err){return res.status(err.statusCode||500).json({success:false,code:err.code&&err.statusCode?err.code:'REPORT_FAILED',message:err.statusCode?err.message:'Unable to generate the live accounting report. Please retry.'});}
};
