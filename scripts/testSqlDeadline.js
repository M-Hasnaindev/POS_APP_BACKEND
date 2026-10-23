const assert = require('node:assert/strict');
const { withSqlDeadline } = require('../services/sqlDeadline');
(async () => {
 let cancellations=0;
 assert.equal(await withSqlDeadline({cancel(){cancellations++;}},20,async()=>42),42);
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(cancellations,0,'successful request must clear timer');
 const source=new Error('source error');
 await assert.rejects(withSqlDeadline({cancel(){throw new Error('unexpected cancel');}},50,async()=>{throw source;}),error=>error===source);
 let rejectRequest;
 const running=new Promise((_,reject)=>{rejectRequest=reject;});
 await assert.rejects(withSqlDeadline({cancel(){cancellations++;rejectRequest(Object.assign(new Error('cancelled'),{code:'ECANCEL'}));}},5,()=>running),error=>error.code==='REPORT_SOURCE_TIMEOUT'&&error.statusCode===504&&error.cause.code==='ECANCEL');
 assert.equal(cancellations,1);
 console.log('PASS: SQL deadline cancels actual request, preserves source errors and clears timers.');
})().catch(error=>{console.error(error);process.exitCode=1;});
