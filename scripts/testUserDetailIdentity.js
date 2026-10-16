const assert = require('node:assert/strict');
const dbPath = require.resolve('../config/db');
const rows = [
  { CompanyCode: 'C1', UserID: 'same-id', UserType: 'U', AllowBranches: 'N' },
  { CompanyCode: 'C2', UserID: 'same-id', UserType: 'A', AllowBranches: 'Y' },
  { CompanyCode: null, UserID: 'legacy', UserType: 'U', AllowBranches: 'N' },
];
let tenant;
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  sql: { VarChar: 'varchar' },
  getPoolForTenant: async id => {
    tenant = id;
    return { request() {
      const params = {};
      return {
        input(key, type, value) { params[key] = value; return this; },
        async query(text) {
          assert.match(text, /LTRIM\(RTRIM\(ISNULL\(CompanyCode, ''\)\)\) = @companyCode/);
          return { recordset: rows.filter(row => row.UserID === params.userId && String(row.CompanyCode ?? '').trim() === params.companyCode) };
        },
      };
    } };
  },
} };
const { getUserDetail } = require('../controllers/authController');
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
(async () => {
  for (const companyCode of ['C2', 'C1']) {
    const res = response();
    await getUserDetail({ user: { tenantId: 'tenant2', companyCode, userId: 'same-id' } }, res);
    assert.equal(tenant, 'tenant2');
    assert.equal(res.body.user.CompanyCode, companyCode);
    assert.equal(res.body.user.AllowBranches, companyCode === 'C2' ? 'Y' : 'N');
  }
  let res = response();
  await getUserDetail({ user: { tenantId: 'tenant2', companyCode: 'C3', userId: 'same-id' } }, res);
  assert.equal(res.statusCode, 404);
  res = response();
  await getUserDetail({ user: { tenantId: 'tenant2', companyCode: '', userId: 'legacy' } }, res);
  assert.equal(res.body.user.UserID, 'legacy');
  console.log('User detail identity isolation tests passed (mock database).');
})().catch(error => { console.error(error); process.exitCode = 1; });
