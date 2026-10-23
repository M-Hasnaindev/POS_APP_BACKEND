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

## Browser push (POS web)
- Set WEB_PUSH_PUBLIC_KEY, WEB_PUSH_PRIVATE_KEY, WEB_PUSH_SUBJECT in the backend Production environment before deploying this release. A VAPID pair was generated locally; keep the private key server-side and preserve the pair across releases.
- Deploy backend and regenerate/upload the web publish together. Export includes pos-notifications-sw.js and manifest.webmanifest. Worker must return JavaScript over HTTPS, not an HTML fallback.
- Signed-in users enable notifications in Profile using Allow/Register. Do not request browser permission automatically on startup. iPhone/iPad users need a Home Screen installation (iOS/iPadOS 16.4+).
- Web subscriptions use WEB: endpoint hashes in existing device records, a separate subscription column, the existing tenant/user routing, preferences, dedupe logs and five-minute push worker.
- Successful web delivery means accepted by the browser push provider, not proof that a person saw the notification. Browser/OS policy, Focus and connectivity can delay it.
- Logout unsubscribes the browser and unregisters the device. Expired endpoints return DeviceNotRegistered and are deactivated by the existing worker.
- Validate on an HTTPS site: Allow in Profile, trigger an authorized test notification, verify with page open, then close the page and repeat. Verify sign-out stops delivery. Do not send tests to unrelated client devices.
