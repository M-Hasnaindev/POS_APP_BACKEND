const express = require("express");
const {
  getSnapshot,
  startSnapshotJob,
  getSnapshotJobStatus,
  getSnapshotJobPage,
} = require("../controllers/stockController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();
router.use(verifyToken);
router.post("/snapshot/jobs", startSnapshotJob);
router.get("/snapshot/jobs/:jobId", getSnapshotJobStatus);
router.get("/snapshot/jobs/:jobId/pages", getSnapshotJobPage);
router.get("/snapshot", getSnapshot);

module.exports = router;
