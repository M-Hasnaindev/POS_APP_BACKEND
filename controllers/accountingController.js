const { sql, getPoolForTenant } = require('../config/db');
const { executeAccountingSnapshot, resolveCompanyStartDate, pakistanToday, resolveAuthenticatedCompanyCode } = require('../services/accountingService');
const { sendSyncStream } = require('../services/httpSyncStream');
exports.streamAccountingRecords = async (req, res) => {
    try {
        const { tenantId, userId } = req.user;
        const pool = await getPoolForTenant(tenantId);
        const companyCode = await resolveAuthenticatedCompanyCode(pool, userId, req.user.companyCode, req.headers['x-company-code']);
        const fromDate = await resolveCompanyStartDate(pool, companyCode), toDate = pakistanToday();
        if (!fromDate)
            return res.status(422).json({ success: false, message: 'Company start date is unavailable' });
        return sendSyncStream(req, res, async (onBatch, signal) => {
            const tx = new sql.Transaction(pool);
            await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
            try {
                await new sql.Request(tx).query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource='POSAccountingReports',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000; IF @r<0 THROW 51000,'Report is busy',1;");
                const result = await executeAccountingSnapshot({ request: () => new sql.Request(tx) }, { fromDate, toDate, userId, companyCode, signal }, onBatch);
                return { ...result, fromDate, toDate, userId, companyCode };
            }
            finally {
                await tx.rollback();
            }
        });
    }
    catch (error) {
        return res.status(error.statusCode || 503).json({ success: false, message: 'Accounting download is unavailable. Please retry.' });
    }
};
const retired = (req, res) => res.status(410).json({ success: false, code: 'LOCAL_SYNC_REQUIRED', message: 'Please update the app to use local sync.' });
exports.getAccountingRecords = retired;
exports.startAccountingRecordsJob = retired;
exports.getAccountingRecordsJobStatus = retired;
exports.getAccountingRecordsJobPage = retired;
