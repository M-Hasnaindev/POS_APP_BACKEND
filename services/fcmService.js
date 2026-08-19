const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIREBASE_MESSAGING_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const FCM_TOKEN_PREFIX = "FCM:";

let cachedCredentials = null;
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function normalizePrivateKey(value) {
  return String(value || "").replace(/\\n/g, "\n").trim();
}

function readJsonFile(filePath) {
  if (!filePath) return null;
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function loadFirebaseCredentials() {
  if (cachedCredentials) return cachedCredentials;

  let credentials = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  if (!credentials && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    credentials = {
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    };
  }

  if (!credentials && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    credentials = readJsonFile(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }

  if (!credentials && process.env.FCM_SERVICE_ACCOUNT_FILE) {
    credentials = readJsonFile(process.env.FCM_SERVICE_ACCOUNT_FILE);
  }

  if (!credentials) {
    const localFallback = path.join(__dirname, "..", "config", "firebase-service-account.json");
    credentials = readJsonFile(localFallback);
  }

  if (!credentials?.project_id || !credentials?.client_email || !credentials?.private_key) {
    throw new Error(
      "Firebase FCM V1 credentials are not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY.",
    );
  }

  credentials.private_key = normalizePrivateKey(credentials.private_key);
  cachedCredentials = credentials;
  return cachedCredentials;
}

function toBaseFcmToken(storedToken) {
  const value = String(storedToken || "").trim();
  return value.startsWith(FCM_TOKEN_PREFIX) ? value.slice(FCM_TOKEN_PREFIX.length) : value;
}

function isDirectFcmToken(storedToken) {
  return String(storedToken || "").trim().startsWith(FCM_TOKEN_PREFIX);
}

function isFcmConfigured() {
  try {
    loadFirebaseCredentials();
    return true;
  } catch {
    return false;
  }
}

async function getFirebaseAccessToken() {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessTokenExpiresAt - now > 60 * 1000) {
    return cachedAccessToken;
  }

  const credentials = loadFirebaseCredentials();
  const issuedAt = Math.floor(now / 1000);
  const assertion = jwt.sign(
    {
      iss: credentials.client_email,
      scope: FIREBASE_MESSAGING_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + 3600,
    },
    credentials.private_key,
    { algorithm: "RS256" },
  );

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.access_token) {
    throw new Error(
      `Unable to obtain Firebase access token (${response.status}): ${payload?.error_description || payload?.error || "unknown error"}`,
    );
  }

  cachedAccessToken = String(payload.access_token);
  cachedAccessTokenExpiresAt = now + Math.max(60, Number(payload.expires_in || 3600)) * 1000;
  return cachedAccessToken;
}

function mapFcmError(statusCode, payload) {
  const status = String(payload?.error?.status || "").trim();
  const message = String(payload?.error?.message || `FCM request failed (${statusCode})`).trim();
  const detailCodes = Array.isArray(payload?.error?.details)
    ? payload.error.details.map((item) => String(item?.errorCode || item?.reason || "").trim()).filter(Boolean)
    : [];
  const rawCode = detailCodes.find(Boolean) || status;

  if (statusCode === 404 || rawCode === "UNREGISTERED") {
    return { code: "DeviceNotRegistered", message };
  }
  if (statusCode === 401 || statusCode === 403 || status === "UNAUTHENTICATED" || status === "PERMISSION_DENIED") {
    return { code: "InvalidCredentials", message };
  }
  if (rawCode === "SENDER_ID_MISMATCH") {
    return { code: "MismatchSenderId", message };
  }
  if (status === "RESOURCE_EXHAUSTED") {
    return { code: "MessageRateExceeded", message };
  }
  return { code: rawCode || status || "FCMError", message };
}

function stringData(data) {
  const output = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null) continue;
    output[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return output;
}

async function sendOneFcmMessage(message, accessToken, projectId) {
  const token = toBaseFcmToken(message.to);
  const payload = {
    message: {
      token,
      notification: {
        title: String(message.title || "Notification"),
        body: String(message.body || "You have a new notification."),
      },
      data: stringData(message.data),
      android: {
        priority: message.priority === "high" ? "HIGH" : "NORMAL",
        notification: {
          channel_id: String(message.channelId || "business_notifications"),
          sound: "default",
        },
      },
    },
  };

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  const responsePayload = await response.json().catch(() => null);
  if (!response.ok) {
    const mapped = mapFcmError(response.status, responsePayload);
    return {
      status: "error",
      message: mapped.message,
      details: { error: mapped.code },
    };
  }

  return {
    status: "ok",
    id: String(responsePayload?.name || ""),
  };
}

async function sendFcmPush(messages) {
  if (!messages.length) return [];
  const credentials = loadFirebaseCredentials();
  const accessToken = await getFirebaseAccessToken();
  const results = new Array(messages.length);
  const concurrency = Math.min(20, messages.length);
  let cursor = 0;

  async function worker() {
    while (cursor < messages.length) {
      const index = cursor;
      cursor += 1;
      try {
        const ticket = await sendOneFcmMessage(messages[index], accessToken, credentials.project_id);
        results[index] = { message: messages[index], ticket, provider: "fcm" };
      } catch (error) {
        results[index] = {
          message: messages[index],
          provider: "fcm",
          ticket: {
            status: "error",
            message: error?.message || "FCM delivery failed",
            details: { error: "FCMError" },
          },
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

module.exports = {
  FCM_TOKEN_PREFIX,
  isDirectFcmToken,
  isFcmConfigured,
  sendFcmPush,
};
