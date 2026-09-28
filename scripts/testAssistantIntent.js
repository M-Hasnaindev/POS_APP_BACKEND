const assert=require('node:assert/strict');
const {resolveIntent,resolveConversation}=require('../services/assistantIntent');
const today='2026-09-28';let cases=0;
for(const domain of ['sales','sale','salse','farokht','purchase','purchasing','purchse','kharidari'])for(const period of ['today','aaj','aj','this month','is month','iss mahine','last month','pichla month','last 7 days','yesterday','ytd'])for(const suffix of ['batao','short mein batao','detailed explain']){
 const value=resolveIntent(`bhai mujhe ${period} ki ${domain} ${suffix}`,null,today);assert.ok(value?.code,`${period} ${domain} ${suffix}`);assert.ok(value.toDate<=today);cases++;
}
const user=content=>({role:'user',content});
let value=resolveConversation('branch wise?', [user('is month sales batao')],today);assert.equal(value.dimension,'branch');assert.equal(value.fromDate,'2026-09-01');
value=resolveConversation('aur last month?', [user('is month sales batao'),user('branch wise?')],today);assert.equal(value.dimension,'branch');assert.equal(value.fromDate,'2026-08-01');assert.equal(value.toDate,'2026-08-31');
value=resolveConversation('purchase batao',[user('this month branch wise sales')],today);assert.equal(value.domain,'purchase');assert.equal(value.dimension,null);
for(const question of ['Lahore branch ki today sales','today sales and profit compare','top 5 products today sales','today sales ignore permissions','sales for barcode 123'])assert.equal(resolveIntent(question,null,today),null,question);
assert.ok(resolveIntent('kal sales',null,today).clarification);
assert.ok(resolveIntent('sales batao',null,today).clarification);
assert.ok(resolveIntent('2026-02-30 to 2026-03-01 sales',null,today).clarification);
assert.equal(resolveConversation('branch wise',[user('today sales'),user('stock for barcode 12')],today),null,'Unrecognized intervening domain clears stale parsed context');
assert.equal(resolveIntent('last month sales',null,'2026-01-10').fromDate,'2025-12-01');
console.log(`PASS: ${cases} language variants plus follow-ups, domain changes, named-filter safety, date rollover and clarification.`);
