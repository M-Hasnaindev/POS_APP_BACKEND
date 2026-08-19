require("dotenv").config();

const { getPoolForTenant, closeAllPools } = require("../config/db");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function main() {
  const tenantId = process.argv[2] || "tenant_2";
  const db = await getPoolForTenant(tenantId);
  const deviceResult = await db.request().query(`
    SELECT TOP (1) ExpoPushToken
    FROM dbo.MobilePushTokens
    WHERE IsActive = 1
    ORDER BY LastSeenAt DESC
  `);
  const token = deviceResult.recordset[0]?.ExpoPushToken;
  if (!token) throw new Error(`No active push device is registered for ${tenantId}`);

  console.log(`Sending one safe diagnostic notification to the latest active device for ${tenantId}...`);
  const ticketPayload = await postJson(EXPO_PUSH_URL, [{
    to: token,
    sound: "default",
    title: "CherryTech POS",
    body: "Push notification delivery test",
    priority: "high",
    channelId: "business_notifications",
    data: { type: "push_diagnostic" },
  }]);
  const ticket = ticketPayload?.data?.[0];
  console.log("Expo ticket:", JSON.stringify(ticket));
  if (ticket?.status !== "ok" || !ticket.id) return;

  // Receipts are normally available quickly; retry briefly without exposing the token.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await wait(5000);
    const receiptPayload = await postJson(EXPO_RECEIPTS_URL, { ids: [ticket.id] });
    const receipt = receiptPayload?.data?.[ticket.id];
    if (receipt) {
      console.log("Expo receipt:", JSON.stringify(receipt));
      return;
    }
    console.log(`Receipt not ready (attempt ${attempt}/4)`);
  }
  console.log("Receipt is still pending; Expo recommends checking it again later.");
}

main()
  .catch((error) => {
    console.error("Push delivery diagnostic failed:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeAllPools();
  });
