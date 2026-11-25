const express = require("express");
const {
  getAttendanceHistory,
  employeeMonthlySchedule,
  monthlyAttendance,
  employeeSalary,
} = require("../controllers/payrollController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(verifyToken);
router.post("/attendance-history", getAttendanceHistory);
router.get("/employeeAttendenceHistory/:empCode", getAttendanceHistory);
// Employee monthly schedule: EXEC HREmployeeAttHistory ...,'Y' (the misspelt path is kept as an alias)
router.get("/employeeMonthlySchedule/:empCode", employeeMonthlySchedule);
router.get("/employeeMonthlySchdeule/:empCode", employeeMonthlySchedule);
// Overall monthly attendance: SELECT * FROM PayrollAttendInfo
router.get("/monthlyAttendance", monthlyAttendance);
// Employee salaries: SELECT * FROM PayRollSalaryFile
router.get("/employeeSalary", employeeSalary);
router.get("/employeeSalary/:empCode", employeeSalary);

module.exports = router;
