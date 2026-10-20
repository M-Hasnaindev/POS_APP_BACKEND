const assert = require('node:assert/strict');
const { validatePlan, planAssistant } = require('../services/assistantTools');
const call = { tool: 'salesSummary', fromDate: '2026-09-01', toDate: '2026-09-30', branches: ['A'] };
assert.throws(() => validatePlan({ calls: [{ ...call, tool: 'executeSql' }] }, ['A']), /Invalid/);
assert.throws(() => validatePlan({ calls: [{ ...call, branches: ['B'] }] }, ['A']), /unavailable/);
assert.throws(() => validatePlan({ calls: [{ ...call, fromDate: '2026-02-30' }] }, ['A']), /Invalid/);
assert.throws(() => validatePlan({ calls: Array(4).fill(call) }, ['A']), /three/);
assert.equal(validatePlan({ clarification: 'Which dates?' }, ['A']).calls.length, 0);
assert.deepEqual(validatePlan({ calls: [{ ...call, sql: 'DROP TABLE users' }] }, ['A']).calls, [call]);
(async () => {
  let prompt;
  const result = await planAssistant({ question: 'September 2026 sales', permissions: { branches: ['A'] }, context: { branches: [{ Branch: 'A' }, { Branch: 'B' }] } },
    async messages => { prompt = JSON.parse(messages.at(-1).content); return JSON.stringify({ calls: [call] }); }, JSON.parse);
  assert.equal(result.calls[0].tool, 'salesSummary');
  assert.deepEqual(prompt.context.branches, [{ Branch: 'A' }]);
  assert.match(prompt.context.today, /^\d{4}-\d{2}-\d{2}$/);
  console.log('PASS: planner whitelist, permissions, calendar validation, bounded calls, safe clarification and metadata minimization');
})().catch(error => { console.error(error); process.exitCode = 1; });

const { enforceScope } = require('../services/assistantToolScope');
const context = { today: '2026-10-20', branches: [{ Branch: 'A', BranchName: 'Branch A' }], coverage: [] };
const proposed = { calls: [call], clarification: '' };
assert.equal(enforceScope(proposed, 'Aaj ki sales', context, []).calls[0].fromDate, '2026-10-20');
assert.equal(enforceScope(proposed, 'Branch Z sales September 2026', context, []).calls.length, 0);
const followup = enforceScope({ calls: [{ ...call, branches: [], fromDate: '2026-10-01' }] }, 'Ab isi ka expense breakdown', context, [call]);
assert.equal(followup.calls[0].fromDate, '2026-09-01');
assert.deepEqual(followup.calls[0].branches, ['A']);
assert.equal(enforceScope(proposed, 'sales batao', context, []).calls.length, 0);
assert.equal(enforceScope(proposed, '1 September 2026 se 30 September 2026 branch A', context, []).calls[0].toDate, '2026-09-30');
console.log('PASS: model date drift corrected, unknown branches blocked, follow-up scope retained, missing dates clarified');
