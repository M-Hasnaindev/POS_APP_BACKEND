const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function check(hasCardReturn) {
  const queries = [];
  const inputs = {};
  const pool = { request() { return {
    input(key, type, value) { inputs[key] = value; return this; },
    async query(text) {
      queries.push(text);
      if (text.includes('COL_LENGTH')) return { recordset: [{ cardReturnLength: hasCardReturn ? 9 : null }] };
      if (!hasCardReturn && /M\.CardReturn/.test(text)) throw new Error("Invalid column name 'CardReturn'");
      return { recordset: [{ TranNo: 'test', CardReturn: hasCardReturn ? 125 : null }] };
    },
  }; } };
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers/closingController.js'), 'utf8'), {
    module: mod, console,
    require(name) {
      if (name === '../services/accountingService') return { resolveAuthenticatedCompanyCode: async (_pool, _user, company) => company };
      assert.equal(name, '../config/db');
      return { sql: { VarChar: () => 'varchar', Date: 'date' },
        getPoolForTenant: async id => { assert.equal(id, 'tenant_test'); return pool; },
        sendDatabaseError: (_, error) => { throw error; } };
    },
  });
  let body;
  await mod.exports.getClosings({ user: { tenantId: 'tenant_test', companyCode: 'AUTH' },
    query: { from: '2026-11-01', to: '2026-11-17', branch: "branch'", companyCode: 'OTHER' } },
    { json(value) { body = value; }, status() { return this; } });
  assert.equal(body.success, true);
  assert.equal(body.data[0].CardReturn, hasCardReturn ? 125 : null);
  assert.equal(inputs.companyCode, 'AUTH');
  assert.equal(inputs.branch, "branch'");
  assert.equal(queries.length, 2);
  assert.match(queries[1], /M\.CompanyCode\)\) = @companyCode/);
  assert(!queries[1].includes("branch'"));
  assert(!queries.some(q => /\b(CREATE|ALTER|UPDATE|DELETE|INSERT)\b/i.test(q)));
}
(async () => { await check(false); await check(true); console.log('PASS: closing list supports both ERP schemas, preserves recorded returns and authenticated company scope, with read-only queries.'); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
