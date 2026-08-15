const express = require("express");
const {
  getSalesReport,
  getSalesReportAll,
  getSalesReportCount,
  getBarcodes,
  getBranchList,
  getEmployeeView,
} = require("../controllers/salesController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(verifyToken);

router.get("/sales-report", getSalesReport);
router.get("/barcodes", getBarcodes);
router.get("/branch-list", getBranchList);
router.get("/employee-view", getEmployeeView);
router.get("/sales-report-count", getSalesReportCount);
router.get("/sales-report-all", getSalesReportAll);

module.exports = router;
