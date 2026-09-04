const express = require("express");
const { verifyToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/aiController");

const router = express.Router();
router.use(verifyToken);
router.get("/health", controller.health);
router.get("/catalog", controller.catalog);
router.get("/reports", controller.listReports);
router.get("/filters", controller.filterOptions);
router.post("/reports/:code/run", controller.runReport);
router.post("/reports/:code/insight", controller.reportInsight);
router.post("/assistant", controller.assistant);
router.post("/chat", controller.assistant);

module.exports = router;
