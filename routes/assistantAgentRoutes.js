const express = require("express");
const { verifyToken } = require("../middleware/authMiddleware");
const agent = require("../services/assistantAgent");

const router = express.Router();
router.use(verifyToken);
// Tool results (query rows) travel with the conversation, so allow a larger body here only.
router.post("/turn", express.json({ limit: "6mb" }), agent.streamTurn);
router.get("/status", agent.status);
module.exports = router;
