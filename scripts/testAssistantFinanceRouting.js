const assert = require('node:assert/strict');
const {planAssistant,validatePlan}=require('../services/assistantTools');
const permissions={branches:['A']};
const context={branches:[{Branch:'A',BranchName:'Branch A'}],coverage:[]};
(async()=>{
 for(const question of ['aj ka total bills and net sales batao','aaj ki sales aur total bills batao','today total bills and net sales']) {
  const plan=await planAssistant({question,permissions,context},()=>{throw Error('Simple question must not depend on model');},JSON.parse);
  assert.equal(plan.calls[0].tool,'salesSummary');assert.equal(plan.calls[0].fromDate,plan.calls[0].toDate);
 }
 const call={tool:'accountingReport',reportId:'balance-sheet',fromDate:'2026-09-30',toDate:'2026-09-30',branches:[]};
 assert.throws(()=>validatePlan({calls:[{...call,reportId:'delete-users'}]},['A']),/Unsupported/);
 const plan=await planAssistant({question:'as on 2026-09-30 balance sheet',permissions,context},async()=>JSON.stringify({calls:[call]}),JSON.parse);
 assert.equal(plan.calls[0].reportId,'balance-sheet');
 let attempts=0;
 const retried=await planAssistant({question:'September 2026 cash flow',permissions,context},async()=>JSON.stringify({calls:[{...call,tool:++attempts===1?'cashFlow':'accountingReport',reportId:'daily-cash-bank-flow',fromDate:'2026-09-01',toDate:'2026-09-30'}]}),JSON.parse);
 assert.equal(attempts,2);assert.equal(retried.calls[0].toDate,'2026-09-30');
 const nonanswer=await planAssistant({question:'September 2026 expense',permissions,context},async()=>JSON.stringify({clarification:'Today is 2026-10-20.'}),JSON.parse);
 assert.doesNotMatch(nonanswer.clarification,/Today is/);
 const {enforceScope}=require('../services/assistantToolScope');
 const position=enforceScope({calls:[{...call,reportId:'daily-cash-bank-flow'}]},'as on 2026-09-30 cash bank position',{...context,today:'2026-10-20'},[]);
 assert.equal(position.calls[0].reportId,'cash-bank-position');
 for(const [question,date] of [['Account Inquiry',null],['Account Inquiry as on 2026-09-30','2026-09-30'],['Account Inquiry 30 September 2026','2026-09-30'],['Account Inquiry 30/09/2026','2026-09-30']]) {
  const result=await planAssistant({question,permissions,context},()=>{throw Error('Account Inquiry must not ask model for missing start date');},JSON.parse);
  assert.equal(result.calls[0].tool,'accountInquiry');
  assert.equal(result.calls[0].fromDate,result.calls[0].toDate);
  if(date)assert.equal(result.calls[0].toDate,date);
 }
 console.log('PASS: common Roman Urdu/English sales bypass, accounting whitelist, as-on dates, bounded schema repair, date-only answer rejected');
})().catch(e=>{console.error(e);process.exitCode=1;});
