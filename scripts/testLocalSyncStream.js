const assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {sendSyncStream}=require('../services/httpSyncStream');
class Response extends EventEmitter{constructor(){super();this.lines=[];this.writableEnded=false;}set(){}flushHeaders(){}write(value){this.lines.push(JSON.parse(value));return true;}end(){this.writableEnded=true;}}
(async()=>{
 let r=new Response();await sendSyncStream({},r,async(batch)=>{await batch([{amount:0},{amount:10}]);return {companyCode:'UR'};});assert.deepEqual(r.lines.map(x=>x.type),['batch','complete']);assert.equal(r.lines[1].count,2);assert.equal(r.lines[1].batches,1);
 r=new Response();await sendSyncStream({},r,async(batch)=>{await batch([{amount:5}]);throw Error('failure');});assert.deepEqual(r.lines.map(x=>x.type),['batch','error']);
 process.env.RESOURCE_SYNC_DATABASE='CHERRYS_APP_SYNC';const retired=require('../services/resourceDeltaStore');assert.equal(retired.enabled(),false);assert.throws(()=>retired.pool(),/retired/);
 const store=require('../services/syncPageStore');await assert.rejects(store.startJob(),e=>e.code==='LOCAL_SYNC_REQUIRED');
 console.log('PASS: complete/error stream markers and retired database cannot reconnect even with old env.');
})().catch(e=>{console.error(e);process.exitCode=1});
