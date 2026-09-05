const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bank = require('../ai/questionBank.generated.json');
const { parseSurfaceIntent, verifiedRouteForIntent } = require('../ai/intentParser');
const { resolveSemanticTrainingIntent } = require('../ai/trainingSemanticRouter');

assert.strictEqual(bank.questionCount, 10000);
assert.strictEqual(bank.centralized, true, 'Question bank must be centralized');
const corpus = bank.questions.map((q) => q.question).join('\n').toLowerCase();
for (const leaked of ['mission road sukkur','station road larkana','mens mission road sukkur','sufyan ali','cotton chinos','00000000007041']) {
  assert.strictEqual(corpus.includes(leaked), false, `Tenant/sample value leaked into central corpus: ${leaked}`);
}

for (const question of [
  'is month kis supplier ko sabse ziyada payment kari h',
  'which vendor did we pay the most this month',
  'kis vendor ko paise sab se ziyada diye',
]) {
  const surface = parseSurfaceIntent(question);
  const route = verifiedRouteForIntent(surface);
  assert.strictEqual(surface.domain, 'accounts', question);
  assert.strictEqual(surface.special, 'supplier-payment', question);
  assert.strictEqual(route.kind, 'direct-engine', question);
  assert.strictEqual(route.engine, 'supplier-payment', question);
  const semantic = resolveSemanticTrainingIntent(question, 12);
  assert.strictEqual(semantic.unsafeAmbiguity, false, question);
  assert.strictEqual(semantic.route?.engine, 'supplier-payment', question);
}

const accountingSource = fs.readFileSync(path.join(__dirname, '../services/accountingReportService.js'), 'utf8');
for (const required of ["FROM CBook", "FROM BBook", "PartyType,'')='S'", "CHARINDEX('/P/'", "BookAccount='N'", "CancelVoucher", "SupplierName Label", "CompanyCode=@companyCode"]) {
  assert.ok(accountingSource.includes(required), `Supplier-payment engine missing rule: ${required}`);
}

console.log('Central tenant-independent Assistant + supplier-payment routing tests passed');
