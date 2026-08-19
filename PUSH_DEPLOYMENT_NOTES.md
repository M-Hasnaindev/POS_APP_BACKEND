# Business Push Deployment Notes

The backend push worker reads new rows from `dbo.Notifications`, matches them to registered `MobilePushTokens`, applies notification preferences, sends them through Expo Push Service, and logs only successful Expo tickets.

Important deployment points:

- Deploy this backend together with the matching frontend build.
- This project is configured for **Vercel Hobby**, so `vercel.json` intentionally contains no Vercel cron schedule. Hobby plans reject cron expressions that run more than once per day.
- Keep `CRON_SECRET` configured in Vercel. The external scheduler must send it as `Authorization: Bearer <CRON_SECRET>`.
- `/api/notifications/process-push` is the protected push-worker endpoint.
- Configure an external scheduler to call that endpoint every 10 minutes.
- The frontend Android build must have valid Firebase/FCM credentials. Backend code cannot generate those credentials.
- Expo ticket errors such as `DeviceNotRegistered` are handled; other Expo delivery errors are surfaced in Vercel logs and are not silently marked as delivered.

## External scheduler request

Method: `GET`

URL:

`https://YOUR-VERCEL-DOMAIN/api/notifications/process-push`

Header:

`Authorization: Bearer YOUR_CRON_SECRET`

Schedule: every 10 minutes.
