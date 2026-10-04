const assert=require('node:assert/strict');
const {gunzipSync}=require('zlib');
const {sendSyncJson}=require('../services/syncResponse');
(async()=>{
 const data={success:true,data:Array.from({length:5000},(_,id)=>({id,name:'test account',raw:'x'.repeat(1600)}))};
 const headers={};let sent;
 const res={set(k,v){headers[k]=v;return this;},send(value){sent=value;},json(value){sent=value;}};
 await sendSyncJson({headers:{'accept-encoding':'gzip, deflate'}},res,data);
 assert.equal(headers['Content-Encoding'],'gzip');assert(sent.length<4500000);
 assert.deepEqual(JSON.parse(gunzipSync(sent)),data);
 await sendSyncJson({headers:{}},res,data);assert.strictEqual(sent,data);
 console.log('PASS: lossless compressed 5000-row response and plain JSON fallback.');
})().catch(error=>{console.error(error);process.exitCode=1});
