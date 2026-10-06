const express = require("express");
const {
  getAccountingRecords,
  getLiveAccountingReport,
  startAccountingRecordsJob,
  getAccountingRecordsJobStatus,
  getAccountingRecordsJobPage,
} = require("../controllers/accountingController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/records", verifyToken, getAccountingRecords);
router.post("/records/jobs", verifyToken, startAccountingRecordsJob);
router.get("/records/jobs/:jobId", verifyToken, getAccountingRecordsJobStatus);
router.get("/records/jobs/:jobId/pages", verifyToken, getAccountingRecordsJobPage);
router.get("/reports/:reportType", verifyToken, getLiveAccountingReport);

module.exports = router;
