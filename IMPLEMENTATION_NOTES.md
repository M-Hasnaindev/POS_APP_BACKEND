# CherryTech Mobile Multi-Tenant Implementation Notes

## Implemented flow

1. First app launch opens **Company Key** selection.
2. Backend resolves the key to a server-side tenant/database and returns a signed tenant token. Database credentials never go to the mobile app.
3. PIN login is bound to that tenant. Access JWT contains the tenant id, and every protected Sales/Auth endpoint selects the correct SQL connection pool from the JWT tenant id.
4. Each tenant gets a separate local SQLite file on the phone.
5. Initial Sales and Barcode downloads are paginated and checkpointed in SQLite. If setup is interrupted, the next launch resumes from the last committed page rather than clearing successful pages and starting again.
6. Branch and Employee masters are loaded after the large datasets.
7. Home prepares a persistent merged Sales cache on a separate WAL-mode SQLite connection. Dashboard can use the cache when ready or fall back to an accurate live JOIN.
8. Background refresh is gated by selected tenant + access token + completed config. It refreshes only Today + Yesterday Sales, rebuilds the merged cache, and never clears the full historical tables.
9. Dashboard manual refresh also refreshes Today + Yesterday plus the small Branch/Employee masters. It intentionally does not clear the 100k+ Barcode catalog.
10. Sync notifications are reduced to professional start / completed / paused messages instead of repeated percentage notifications.

## Backend environment

The supplied `.env` had two `DB_DATABASE` entries. It has been converted to:

- `DB_1_DATABASE`
- `DB_1_KEY`
- `DB_1_LABEL`
- `DB_2_DATABASE`
- `DB_2_KEY`
- `DB_2_LABEL`

Shared SQL Server settings remain in `DB_USER`, `DB_PASSWORD`, `DB_SERVER`, and `DB_PORT` unless a tenant-specific override is later added.

Use the value of `DB_1_KEY` or `DB_2_KEY` on the new Company Key screen. Keep those keys private and rotate them if they are exposed.

## Storage roles

- **SQLite:** heavy/persistent Sales, Barcode, Branch, Employee, checkpoints, merged dashboard cache.
- **Persistent app store:** selected tenant, user summary, sync/UI state. Large transaction arrays are deliberately not stored in JS state.
- **AsyncStorage:** current implementation uses the dependencies already present in the supplied source for session persistence.

## Important limitations of the supplied frontend ZIP

The frontend archive does not contain `package.json`, `package-lock.json`/lock file, `tsconfig.json`, or the native `android/` project. Therefore:

- A real Expo/React Native dependency install and APK build cannot be reproduced from this archive alone.
- I did not add new external Redux Toolkit / SecureStore dependencies that could make the project fail to resolve without the missing package manifest. The included persistent app store follows the recommended Redux-style separation while keeping heavy data in SQLite.
- A true Android WorkManager foreground worker that can continue long work more reliably after process termination requires the native Android project. The current Expo-side initial setup is **resume-safe**: committed pages are preserved and setup resumes when the app is opened again. It does not falsely promise guaranteed execution after Android force-stop.

## Validation performed

- All backend `.js` files pass `node --check` syntax validation.
- All 36 frontend `.ts/.tsx` files pass TypeScript parser/transpile syntax validation.
- All relative frontend imports resolve to existing local files.
- Existing Login, Config, Home, Sales Dashboard, and Profile `StyleSheet` sections are byte-for-byte unchanged from the supplied frontend ZIP.
- Removed conflicting legacy database/background-sync source generations from the working frontend package.
- Backend package installation/runtime DB test could not be completed in the sandbox because dependency installation timed out and the actual SQL Server is not reachable here. Live table/schema compatibility for both configured databases must be verified on your server.
