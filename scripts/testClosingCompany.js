const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function check(endpoint, tokenCompany, securityCompanies, tenantCompanies, expectedCompany) {
  const queries = [];
  const sql = { VarChar: () => 'varchar', Date: 'date' };
  const pool = { request() {
    const inputs = {};
    return {
      input(key, type, value) { inputs[key] = value; return this; },
      async query(text) {
        queries.push({ text, inputs });
        if (text.includes('FROM Security')) return { recordset: securityCompanies.map(CompanyCode => ({ CompanyCode })) };
        if (text.includes('TenantCompanies')) return { recordset: tenantCompanies.map(CompanyCode => ({ CompanyCode })) };
        if (text.includes('COL_LENGTH')) return { recordset: [{ cardReturnLength: null }] };
        return { recordset: [], recordsets: [[], [{ found: 1 }]] };
      },
    };
  } };
  const accounting = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/accountingService.js'), 'utf8'), {
    module: accounting, console,
    require(name) {
      if (name === '../config/db') return { sql };
      if (name === './streamRows') return {};
      throw new Error(name);
    },
  });
  const controller = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../controllers/closingController.js'), 'utf8'), {
    module: controller, console,
    require(name) {
      if (name === '../services/accountingService') return accounting.exports;
      assert.equal(name, '../config/db');
      return { sql, getPoolForTenant: async id => { assert.equal(id, 'authenticated-tenant'); return pool; },
        sendDatabaseError: (_, error) => { throw error; } };
    },
  });
  let body, status = 200;
  await controller.exports[endpoint]({
    user: { tenantId: 'authenticated-tenant', userId: 'authenticated-user', companyCode: tokenCompany },
    query: { from: '2026-11-01', to: '2026-11-17', branch: 'B', companyCode: 'UNTRUSTED' },
    headers: { 'x-company-code': 'UNTRUSTED' }, params: { tranNo: 'T' },
  }, { status(code) { status = code; return this; }, json(value) { body = value; } });
  const dataQueries = queries.filter(q => q.text.includes('FROM PosClosing'));
  if (expectedCompany) {
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(dataQueries.length, 1);
    assert.equal(dataQueries[0].inputs.companyCode, expectedCompany);
  } else {
    assert.equal(status, 401);
    assert.equal(body.success, false);
    assert.equal(dataQueries.length, 0);
  }
  for (const query of queries) {
    assert(!/\b(CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(query.text));
    assert(!Object.values(query.inputs).includes('UNTRUSTED'));
    if (query.text.includes('FROM Security')) assert.equal(query.inputs.userId, 'authenticated-user');
  }
}

(async () => {
  for (const endpoint of ['getClosings', 'getClosingBreakup']) {
    await check(endpoint, 'SIGNED', [], [], 'SIGNED');
    await check(endpoint, '', ['USER_COMPANY'], [], 'USER_COMPANY');
    await check(endpoint, '', [], ['LEGACY'], 'LEGACY');
    await check(endpoint, '', [], ['A', 'B'], null);
    await check(endpoint, '', ['A', 'B'], ['A', 'B'], null);
    await check(endpoint, '', [], [], null);
  }
  console.log('PASS: both closing endpoints resolve authenticated legacy company scope, reject ambiguous/missing scope, ignore client company overrides, and only read source data.');
})().catch(error => { console.error(error); process.exitCode = 1; });
