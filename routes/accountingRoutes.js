const express = require("express");
const { getAccountingRecords, getLiveAccountingReport } = require("../controllers/accountingController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/records", verifyToken, getAccountingRecords);
router.get("/reports/:reportType", verifyToken, getLiveAccountingReport);

module.exports = router;
