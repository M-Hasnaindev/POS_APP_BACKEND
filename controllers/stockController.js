const { sql, getPoolForTenant } = require('../config/db');
const { getStockSnapshot } = require('../services/stockSnapshotService');
const { getBranchPriceAccess } = require('../services/branchPriceAccessService');
const { sendSyncStream } = require('../services/httpSyncStream');
exports.getRanges = async (req, res) => { try {
    const pool = await getPoolForTenant(req.user.tenantId);
    const r = await pool.request().query("WITH Codes AS(SELECT DISTINCT BarCode FROM dbo.BarcodeView WHERE BarCode IS NOT NULL), Numbered AS(SELECT BarCode,(ROW_NUMBER() OVER(ORDER BY BarCode)-1)/1000 bucket FROM Codes) SELECT MIN(BarCode) barcodeFrom,MAX(BarCode) barcodeTo FROM Numbered GROUP BY bucket ORDER BY bucket");
    res.json({ success: true, ranges: r.recordset });
}
catch (error) {
    res.status(503).json({ success: false, message: 'Inventory ranges unavailable. Please retry.' });
} };
exports.streamSnapshot = async (req, res) => {
    try {
        const { tenantId, userId, companyCode } = req.user;
        const { fromDate, toDate, barcodeFrom, barcodeTo } = req.query;
        if (typeof barcodeFrom !== 'string' || !barcodeFrom || typeof barcodeTo !== 'string' || !barcodeTo || barcodeFrom.length > 100 || barcodeTo.length > 100)
            return res.status(400).json({ success: false, message: 'Valid barcode bounds are required' });
        const access = await getBranchPriceAccess({ tenantId, userId, companyCode });
        const branches = access.branches.map(b => String(b.BranchCode).trim()).filter(Boolean);
        if (!branches.length)
            return res.status(403).json({ success: false, message: 'No authorized inventory branches' });
        const pool = await getPoolForTenant(tenantId);
        return sendSyncStream(req, res, async (onBatch, signal) => {
            const tx = new sql.Transaction(pool);
            await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
            try {
                await new sql.Request(tx).query("DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource='POSAccountingReports',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=10000; IF @r<0 THROW 51000,'Report is busy',1;");
                return await getStockSnapshot({ tenantId, userId, companyCode, requestedCompanyCode: req.headers['x-company-code'], fromDate, toDate, barcodeFrom, barcodeTo, branch: ',' + branches.join(',') + ',', transaction: tx, signal }, onBatch);
            }
            finally {
                await tx.rollback();
            }
        });
    }
    catch (error) {
        res.status(error.statusCode || 503).json({ success: false, message: 'Inventory download unavailable. Please retry.' });
    }
};
const retired = (req, res) => res.status(410).json({ success: false, code: 'LOCAL_SYNC_REQUIRED', message: 'Please update the app to use local sync.' });
exports.getSnapshot = retired;
exports.startSnapshotJob = retired;
exports.getSnapshotJobStatus = retired;
exports.getSnapshotJobPage = retired;
