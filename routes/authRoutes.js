const express = require("express");
const router = express.Router();

const {
  resolveTenant,
  login,
  getUserDetail,
  logout,
  getAccountInfo,
  getCompanyLog,
  getAccountName,
} = require("../controllers/authController");
const { verifyToken } = require("../middleware/authMiddleware");

router.post("/tenant/resolve", resolveTenant);
router.post("/login", login);

router.get("/me", verifyToken, getUserDetail);
router.post("/logout", verifyToken, logout);
router.get("/account-info", verifyToken, getAccountInfo);
router.get("/company-log", verifyToken, getCompanyLog);
router.get("/account-name", verifyToken, getAccountName);

module.exports = router;
