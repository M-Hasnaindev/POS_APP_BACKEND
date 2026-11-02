const express = require("express");
const { getAttendanceHistory } = require("../controllers/payrollController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(verifyToken);
router.post("/attendance-history", getAttendanceHistory);
router.get("/employeeAttendenceHistory/:empCode", getAttendanceHistory);

module.exports = router;
