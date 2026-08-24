# Business Push Deployment Notes

The backend push worker reads new rows from `dbo.Notifications`, matches them to registered `MobilePushTokens`, applies notification preferences, sends them through Expo Push Service, and logs only successful Expo tickets.

Important deployment points:

- Deploy this backend together with the matching frontend build.
- This project is configured for **Vercel Hobby**, so `vercel.json` intentionally contains no Vercel cron schedule. Hobby plans reject cron expressions that run more than once per day.
- Keep the same `CRON_SECRET` configured in Vercel and as a GitHub Actions repository secret.
- `/api/notifications/process-push` is the protected push-worker endpoint.
- `.github/workflows/business-push-worker.yml` calls that endpoint every five minutes and also supports a manual run.
- The frontend Android build must have valid Firebase/FCM credentials. Backend code cannot generate those credentials.
- Expo ticket errors such as `DeviceNotRegistered` are handled; other Expo delivery errors are surfaced in Vercel logs and are not silently marked as delivered.

## External scheduler request

Method: `GET`

URL:

`https://YOUR-VERCEL-DOMAIN/api/notifications/process-push`

Header:

`Authorization: Bearer YOUR_CRON_SECRET`

Schedule: every 5 minutes.

## GitHub Actions setup

In the backend GitHub repository, open **Settings → Secrets and variables → Actions**
and create a repository secret named `CRON_SECRET`. Its value must exactly match
the `CRON_SECRET` configured for the Vercel project. After the backend branch is
pushed, run **Business push worker** once from the Actions page and confirm the
JSON response reports `success: true`.
