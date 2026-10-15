# Admin control plane

The React panel calls `/api/admin` through a same-origin Netlify rewrite. Configure `ADMIN_EMAIL`, bcrypt `ADMIN_PASSWORD_HASH`, random `ADMIN_SESSION_SECRET` (at least32 characters), `ADMIN_ALLOWED_ORIGINS` (exact comma-separated browser origins) and `ADMIN_STORE_TENANT_ID` (default tenant_1). Never commit plaintext credentials or production env files. Set NODE_ENV=production on deployed hosts so the admin cookie is Secure.

Before deploying access enforcement, run `npm run admin:setup` with the target environment. This creates only dbo.POSAdminRestrictions, POSAdminTasks, POSAdminSessions, POSAdminAttempts and POSAdminAudit in the central control database. The SQL identity needs CREATE TABLE permission for initialization; schema setup is idempotent and serialized with sp_getapplock. Existing protected app requests and login read this durable control store; outages fail closed with503, so validate central database connectivity before rollout. There is no in-memory allow cache. Schema initializes lazily as a fallback. Restrictions are never created by setup.

Admin sessions last8 hours, use a separate signed HttpOnly cookie with Path=/api/admin and SameSite=Strict, and store only a SHA256 session identifier in SQL. Logout revokes the SQL session. Mutation requests require the exact allowed Origin and X-CSRF-Token from login/session. Login and password reauthentication are rate limited durably in SQL. Changing the admin email or secret invalidates previous sessions.

Tenant/company/user restrictions use the tuple tenantId/companyCode/userId. JWT identity drives every protected request; headers cannot select an unrestricted identity. Tokens without a company claim require login again. Blocked requests return403 ACCESS_RESTRICTED; unavailable verification returns503 ACCESS_CHECK_UNAVAILABLE. GET /api/auth/access-status returns {success:true,allowed:true,checkedAt} only after successful checks.

GET environment returns masked values. POST environment/reveal and environment/download require password reauthentication plus CSRF. Only explicitly supported app database/JWT/resource/AI/Firebase variables are exportable. Admin signing/password secrets and Vercel/Netlify/platform variables are excluded. Tenant key reveal also requires reauthentication. Reveal/download actions are audited without secret values. Downloads contain sensitive application configuration and must be stored securely.

`npm run test:admin` runs isolated mocked-storage security checks and never writes live restrictions or business records. `admin:setup` intentionally initializes the real configured SQL store. No endpoint is provided to mutate deployment environment variables.

Validation warning: the existing npm run test:push is a LIVE diagnostic that sends a notification to a registered device. Do not use it for automated or local validation. npm run test:admin uses only mocks, including notification access decisions, and invokes no delivery transport.

The restriction primary key includes Scope as well as tenant/company/user identity. The idempotent setup migrates the older key transactionally without deleting records. This permits a blank-code Default company restriction independently of a whole-tenant restriction. Run admin:setup and restart long-running processes when upgrading.
