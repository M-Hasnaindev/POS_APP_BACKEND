const assert = require('node:assert/strict');
const ollama = require.resolve('../services/ollamaService');
let calls = 0;
require.cache[ollama] = { id: ollama, filename: ollama, loaded: true, exports: { ollamaChat: async (messages, options) => {
  calls++;
  assert.ok(options.timeoutMs <= 22000);
  assert.match(messages[0].content,/CBook\/BBook/);
  return { clarification:'Which branch and period should I compare?',queries:[] };
} } };
const { planLocalAnalysis,validateSchema,localCatalog } = require('../services/localAiService');
(async()=>{
  const disabled=await planLocalAnalysis({message:'CBook balance'});
  assert.equal(disabled.queries.length,0); assert.equal(calls,0);
  assert.throws(()=>validateSchema([{name:'Security',columns:['PinCode']}]),/not allowed/);
  assert.throws(()=>validateSchema([{name:'PosDetail',columns:['x;DROP TABLE']}]),/Invalid/);
  const answer=await planLocalAnalysis({message:'Which branch is best?',schema:[{name:'BranchFile',columns:['BranchCode','BranchName']}],today:'2026-09-08'});
  assert.ok(answer.clarification); assert.equal(calls,1);
  assert.equal(localCatalog().length,460);
  console.log('PASS: local planner input allowlist, disabled accounting, bounded model calls, clarification and report catalog.');
})().catch(e=>{console.error(e);process.exitCode=1;});
