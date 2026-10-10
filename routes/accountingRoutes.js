const express = require("express");
const {
  getAccountingRecords,
  startAccountingRecordsJob,
  getAccountingRecordsJobStatus,
  getAccountingRecordsJobPage,
} = require("../controllers/accountingController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();
const { getAccountingFilterOptions } = require("../controllers/accountingFilterOptionsController");
router.get("/filter-options", verifyToken, getAccountingFilterOptions);
const { generateAccountingReport } = require("../controllers/accountingReportsController");
router.post("/reports", verifyToken, generateAccountingReport);

router.get("/records", verifyToken, getAccountingRecords);
router.post("/records/jobs", verifyToken, startAccountingRecordsJob);
router.get("/records/jobs/:jobId", verifyToken, getAccountingRecordsJobStatus);
router.get("/records/jobs/:jobId/pages", verifyToken, getAccountingRecordsJobPage);

module.exports = router;
