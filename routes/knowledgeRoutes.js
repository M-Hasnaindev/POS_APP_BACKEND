const express = require("express");
const { verifyToken } = require("../middleware/authMiddleware");
const controller = require("../controllers/knowledgeController");

const router = express.Router();
router.use(verifyToken);
router.get("/manifest", controller.manifest);
router.post("/tables/:table/snapshot", controller.buildSnapshot);
router.get("/tables/:table/delta", controller.snapshotChanges);
router.get("/tables/:table/changes", controller.changes);
router.get("/tables/:table", controller.page);

module.exports = router;
