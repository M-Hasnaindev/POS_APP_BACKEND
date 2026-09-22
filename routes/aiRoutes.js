const express = require("express");
const { verifyToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/aiController");

const router = express.Router();
router.use(verifyToken);
const local = require('../controllers/localAiController');
router.get('/local/reports', local.reports);
router.post('/local/plan', local.plan);
router.post('/local/explain', local.explain);
router.get("/health", controller.health);
router.get("/catalog", controller.catalog);
router.get("/resources", controller.resourceManifest);
router.get("/resources/:table", controller.resourcePage);
router.get("/reports", controller.listReports);
router.get("/filters", controller.filterOptions);
router.post("/reports/:code/run", controller.runReport);
router.post("/reports/:code/insight", controller.reportInsight);
router.post("/assistant", controller.assistant);
router.post("/chat", controller.assistant);

module.exports = router;
