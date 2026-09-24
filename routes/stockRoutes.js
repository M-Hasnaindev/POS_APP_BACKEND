const express = require("express");
const { getSnapshot } = require("../controllers/stockController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(verifyToken);
router.get("/snapshot", getSnapshot);

module.exports = router;
