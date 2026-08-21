const express = require("express");
const {
  getNotifications,
  getRecentNotifications,
  registerPushToken,
  unregisterPushToken,
  testPushNotification,
  processPushNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getNotificationPreferences,
  updateNotificationPreferences,
} = require("../controllers/notificationController");
const { verifyToken } = require("../middleware/authMiddleware");

const router = express.Router();

// Vercel/external scheduler calls this endpoint every 10 minutes.
router.get("/process-push", processPushNotifications);

router.use(verifyToken);
router.get("/recent", getRecentNotifications);
router.get("/preferences", getNotificationPreferences);
router.put("/preferences", updateNotificationPreferences);
router.get("/", getNotifications);
router.post("/register-device", registerPushToken);
router.post("/unregister-device", unregisterPushToken);
router.post("/test-push", testPushNotification);
router.post("/mark-read", markNotificationRead);
router.post("/mark-all-read", markAllNotificationsRead);

module.exports = router;
