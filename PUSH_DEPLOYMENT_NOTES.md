# Business Push Deployment Notes

The backend push worker reads new rows from `dbo.Notifications`, matches them to registered `MobilePushTokens`, applies notification preferences, sends them through Expo Push Service, and logs only successful Expo tickets.

Important deployment points:

- Deploy this backend together with the matching frontend build.
- Configure `CRON_SECRET` in Vercel when using a protected scheduled/external call.
- `/api/notifications/process-push` is the push-worker endpoint.
- `vercel.json` requests `*/10 * * * *`; the hosting plan/scheduler must support that frequency.
- The frontend Android build must have valid Firebase/FCM credentials. Backend code cannot generate those credentials.
- Expo ticket errors such as `DeviceNotRegistered` are handled; other Expo delivery errors are surfaced in Vercel logs and are not silently marked as delivered.
