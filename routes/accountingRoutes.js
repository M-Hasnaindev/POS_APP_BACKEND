const express = require("express");
const { getAccountingRecords } = require("../controllers/accountingController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/records", verifyToken, getAccountingRecords);

module.exports = router;
