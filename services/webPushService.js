const crypto = require('node:crypto');
const webPush = require('web-push');
function validateSubscription(value) {
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) throw new Error('Invalid web push subscription');
  const url = new URL(value.endpoint);
  const host = url.hostname.toLowerCase();
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host === 'push.services.mozilla.com' || host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host === 'wns.windows.com' || host.endsWith('.notify.windows.com');
  if(url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed) throw new Error('Unsupported web push endpoint');
  const keys=value.keys || {};
  if(!/^[A-Za-z0-9_-]+$/.test(keys.p256dh || '') || Buffer.from(keys.p256dh,'base64url').length !== 65 || !/^[A-Za-z0-9_-]+$/.test(keys.auth || '') || Buffer.from(keys.auth,'base64url').length !== 16) throw new Error('Invalid web push keys');
  return {endpoint:url.href,keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
const tokenFor = sub => 'WEB:'+crypto.createHash('sha256').update(sub.endpoint).digest('hex');
const configured = () => Boolean(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY && process.env.WEB_PUSH_SUBJECT);
async function sendWebPush(db, sql, messages) {
  const results=[];
  for(const message of messages) {
    try {
      if(!configured()) throw new Error('Web push configuration missing');
      const row=await db.request().input('token',sql.NVarChar(255),message.to).query('SELECT WebPushSubscription FROM dbo.MobilePushTokens WHERE ExpoPushToken=@token AND IsActive=1');
      const sub=validateSubscription(JSON.parse(row.recordset[0]?.WebPushSubscription || 'null'));
      await webPush.sendNotification(sub,JSON.stringify({title:message.title,body:message.body,data:message.data}),{TTL:3600,timeout:10000,vapidDetails:{subject:process.env.WEB_PUSH_SUBJECT,publicKey:process.env.WEB_PUSH_PUBLIC_KEY,privateKey:process.env.WEB_PUSH_PRIVATE_KEY}});
      results.push({provider:'web',ticket:{status:'ok'}});
    } catch(error) { results.push({provider:'web',ticket:{status:'error',message:'Web push delivery failed',details:{error:[404,410].includes(error.statusCode)?'DeviceNotRegistered':'WebPushDeliveryFailed'}}}); }
  }
  return results;
}
module.exports={validateSubscription,tokenFor,configured,sendWebPush};
