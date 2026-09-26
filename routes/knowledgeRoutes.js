const express = require("express");
const { verifyToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/knowledgeController");

const router = express.Router();
router.use(verifyToken);
router.get("/manifest", controller.manifest);
router.get("/tables/:table/changes", controller.changes);
router.get("/tables/:table", controller.page);

module.exports = router;
