const assert=require('node:assert/strict');
process.env.RESOURCE_SYNC_DATABASE='CHERRYS_APP_SYNC';
const store=require('../services/resourceDeltaStore');
assert.equal(store.enabled(),false);
for(const method of ['pool','initialize','step','changes'])assert.throws(()=>store[method](),error=>error.code==='LOCAL_SYNC_REQUIRED');
console.log('PASS: retired sync database stays disabled with legacy environment settings; no SQL connections.');
