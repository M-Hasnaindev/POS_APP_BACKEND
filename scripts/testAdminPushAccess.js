const assert = require('node:assert/strict');
const { pushAccess } = require('../services/adminPushAccess');
(async () => {
  const unavailableStore = { checkAccess: async () => { throw Error('Admin store must not be queried'); } };
  for (const device of [{CompanyCode:'A',UserId:'7'}, {UserId:'7'}]) {
    assert.deepEqual(await pushAccess('tenant_2',device,unavailableStore), {allowed:true,unavailable:false});
  }
  assert.deepEqual(await pushAccess('tenant_2',{},unavailableStore), {allowed:false,unavailable:false});
  console.log('Push delivery independent of admin restriction storage tests passed.');
})().catch(error => {console.error(error);process.exitCode=1;});
