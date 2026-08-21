const express = require("express");
const { checkAppVersion } = require("../controllers/versionUpdateController");

const router = express.Router();

// Public by design: the mobile app must verify its version before login.
router.get("/", checkAppVersion);

module.exports = router;
