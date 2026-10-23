const assert=require('node:assert/strict');
const push=require('web-push'), {validateSubscription,tokenFor,sendWebPush}=require('../services/webPushService');
const sub={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16,5).toString('base64url')}};
assert.equal(tokenFor(validateSubscription(sub)),tokenFor(sub));
for(const endpoint of ['http://fcm.googleapis.com/test','https://localhost/test','https://127.0.0.1/test','https://fcm.googleapis.com.attacker.test/test','https://user:pass@fcm.googleapis.com/test','https://fcm.googleapis.com:8443/test']) assert.throws(()=>validateSubscription({...sub,endpoint}));
assert.throws(()=>validateSubscription({...sub,keys:{auth:'abc',p256dh:'abc'}}));
process.env.WEB_PUSH_PUBLIC_KEY='test';process.env.WEB_PUSH_PRIVATE_KEY='test';process.env.WEB_PUSH_SUBJECT='mailto:test@example.com';
const db={request:()=>({input(){return this;},async query(){return {recordset:[{WebPushSubscription:JSON.stringify(sub)}]};}})};
(async()=>{const original=push.sendNotification;try{
 let payload;push.sendNotification=async(s,p)=>{payload=JSON.parse(p);};
 const [ok]=await sendWebPush(db,{NVarChar:()=>0},[{to:tokenFor(sub),title:'Test',body:'Safe',data:{route:'/notifications/page'}}]);assert.equal(ok.ticket.status,'ok');assert.equal(payload.title,'Test');
 push.sendNotification=async()=>{throw {statusCode:410};};assert.equal((await sendWebPush(db,{NVarChar:()=>0},[{to:tokenFor(sub)}]))[0].ticket.details.error,'DeviceNotRegistered');
 push.sendNotification=async()=>{throw {statusCode:503};};assert.equal((await sendWebPush(db,{NVarChar:()=>0},[{to:tokenFor(sub)}]))[0].ticket.details.error,'WebPushDeliveryFailed');
 console.log('PASS web push endpoint validation, stable identity, encrypted sender contract and expired/retryable delivery outcomes');
}finally{push.sendNotification=original;}})().catch(e=>{console.error(e);process.exitCode=1;});
