const assert = require('node:assert/strict');
const { hasBusinessData } = require('../services/stockSnapshotService');

for (const field of ['OpAmt', 'PurchaseAmt', 'PurchaseRAmt', 'StockRCAmt', 'StockIssAmt', 'SalesAmt', 'StockADJAmt', 'BalAmt', 'InTransitAmt']) {
  assert.equal(hasBusinessData({ BalQty: 0, [field]: 12.5 }), true, `${field} retains value-only rows`);
  assert.equal(hasBusinessData({ BalQty: 0, [field]: -0.01 }), true, `${field} retains negative adjustments`);
}
assert.equal(hasBusinessData({ BalQty: 2, BalAmt: 0 }), true);
assert.equal(hasBusinessData({ BalQty: 0, BalAmt: 0, CostPrice: 500, RetailPrice: 1000 }), false);
assert.equal(hasBusinessData({ BalQty: 0, BalAmt: 'invalid', StockADJAmt: Infinity }), false);
const rows = [{ BalQty: 1, BalAmt: 100 }, { BalQty: 0, BalAmt: -25 }, { BalQty: 0, BalAmt: 5 }, { BalQty: 0, BalAmt: 0 }];
assert.equal(rows.filter(hasBusinessData).reduce((sum, row) => sum + row.BalAmt, 0), 80);
console.log('PASS: stock snapshot preserves monetary adjustments with zero quantities and excludes price-only seed rows.');
