const express = require("express");
const { verifyToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/aiController");

const router = express.Router();
router.use(verifyToken);
router.get("/health", controller.health);
router.get("/reports", controller.listReports);
router.get("/filters", controller.filterOptions);
router.post("/reports/:code/run", controller.runReport);
router.post("/assistant", controller.assistant);

module.exports = router;
