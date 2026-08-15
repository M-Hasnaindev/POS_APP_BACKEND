const express = require("express");
const router = express.Router();

const {
  login,
  getUserDetail,
  logout,
  getAccountInfo,
  getCompanyLog,
  getAccountName
} = require("../controllers/authController");

const { verifyToken } = require("../middleware/authMiddleware");

// Public routes
router.post("/login", login);

// Protected routes (require authentication)
router.get("/me", verifyToken, getUserDetail);
router.post("/logout", verifyToken, logout);

// New APIs - can be called after login with token
router.get("/account-info", verifyToken, getAccountInfo);
router.get("/company-log", verifyToken, getCompanyLog);

router.get("/account-name", getAccountName);

module.exports = router;
