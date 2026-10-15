const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { fail, digest } = require("./adminStore");
const COOKIE = "cherrys_admin";
const lifetime = 8 * 60 * 60;
const config = () => {
  const email = String(process.env.ADMIN_EMAIL || "")
      .trim()
      .toLowerCase(),
    hash = process.env.ADMIN_PASSWORD_HASH || "",
    secret = process.env.ADMIN_SESSION_SECRET || "";
  if (!email || !/^\$2[aby]\$/.test(hash) || secret.length < 32)
    throw fail("Admin service is not configured.", 503, "ADMIN_UNAVAILABLE");
  return { email, hash, secret };
};
const equals = (a, b) =>
  crypto.timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
function originGuard(req) {
  const origin = req.headers.origin;
  const allowed = (process.env.ADMIN_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    (origin && !allowed.includes(origin)) ||
    (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !origin) ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    throw fail("Request origin is not allowed.", 403, "ADMIN_ORIGIN_REJECTED");
}
function cookie(res, token, maxAge = lifetime * 1000) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure:
      process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL),
    sameSite: "strict",
    path: "/api/admin",
    maxAge,
  });
}
function cookieToken(req) {
  const item = String(req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE + "="));
  return item ? decodeURIComponent(item.slice(COOKIE.length + 1)) : null;
}
async function password(req, store) {
  const c = config();
  await store.rateLimit(
    "admin-password:" + String(req.socket.remoteAddress),
    20,
  );
  await store.rateLimit("admin-password:global", 100);
  const value = req.body?.password;
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !(await bcrypt.compare(value, c.hash))
  )
    throw fail("Invalid admin credentials.", 401, "ADMIN_INVALID_CREDENTIALS");
  return c;
}
async function authenticate(req, store) {
  const c = config();
  let claims;
  try {
    claims = jwt.verify(cookieToken(req), c.secret, {
      algorithms: ["HS256"],
      audience: "cherrys-admin",
      issuer: "cherrys-admin",
    });
  } catch {
    throw fail(
      "Admin session expired. Sign in again.",
      401,
      "ADMIN_UNAUTHENTICATED",
    );
  }
  if (
    claims.type !== "admin" ||
    claims.email !== c.email ||
    typeof claims.sid !== "string" ||
    typeof claims.csrf !== "string"
  )
    throw fail("Invalid admin session.", 401, "ADMIN_UNAUTHENTICATED");
  const session = await store.session(claims.sid);
  if (!session || session.email !== c.email)
    throw fail("Admin session expired.", 401, "ADMIN_UNAUTHENTICATED");
  if (
    !["GET", "HEAD"].includes(req.method) &&
    !equals(req.headers["x-csrf-token"] || "", claims.csrf)
  )
    throw fail("Invalid request token.", 403, "ADMIN_CSRF_REJECTED");
  return claims;
}
async function login(req, res, store) {
  const c = await password(req, store);
  if (
    !equals(
      String(req.body.email || "")
        .trim()
        .toLowerCase(),
      c.email,
    )
  )
    throw fail("Invalid admin credentials.", 401, "ADMIN_INVALID_CREDENTIALS");
  const sid = crypto.randomBytes(32).toString("hex"),
    csrf = crypto.randomBytes(32).toString("hex"),
    expiresAt = new Date(Date.now() + lifetime * 1000).toISOString();
  await store.createSession(sid, c.email, expiresAt);
  const token = jwt.sign(
    { type: "admin", email: c.email, sid, csrf },
    c.secret,
    {
      algorithm: "HS256",
      audience: "cherrys-admin",
      issuer: "cherrys-admin",
      expiresIn: lifetime,
    },
  );
  cookie(res, token);
  return {
    success: true,
    admin: { email: c.email },
    csrfToken: csrf,
    expiresAt,
  };
}
module.exports = {
  config,
  originGuard,
  cookie,
  cookieToken,
  password,
  authenticate,
  login,
  equals,
};
