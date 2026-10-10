const { getPoolForTenant } = require('../config/db');
const { resolveAuthenticatedCompanyCode, resolveCompanyStartDate, pakistanToday } = require('../services/accountingService');
const { loadAccountingFilterOptions } = require('../services/accountingFilterOptions');
exports.getAccountingFilterOptions = async (req,res) => {
  try {
    const tenantId=String(req.user?.tenantId||'').trim(), userId=String(req.user?.userId||'').trim();
    if(!tenantId||!userId)return res.status(401).json({success:false,message:'Please sign in again'});
    const pool=await getPoolForTenant(tenantId);
    const companyCode=await resolveAuthenticatedCompanyCode(pool,userId,req.user?.companyCode,req.headers['x-company-code']);
    const [options,fromDate]=await Promise.all([loadAccountingFilterOptions(pool,{tenantId,userId,companyCode}),resolveCompanyStartDate(pool,companyCode)]);
    return res.json({success:true,...options,companyCode,fromDate:fromDate||null,toDate:pakistanToday()});
  } catch(error) {
    return res.status(error.statusCode||500).json({success:false,message:error.statusCode?error.message:'Unable to load accounting filters. Please retry.'});
  }
};
