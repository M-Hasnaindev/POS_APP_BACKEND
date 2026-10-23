// mssql Request does not implement a per-request `timeout` property. Cancel the
// actual request and await its completion before callers roll back/release it.
async function withSqlDeadline(request, milliseconds, run) {
 let expired=false;
 const timer=setTimeout(()=>{expired=true;request.cancel();},Math.max(1,milliseconds));
 try { return await run(); }
 catch(error) {
  if(expired)throw Object.assign(new Error('The accounting source took too long to respond. Please retry.'),{code:'REPORT_SOURCE_TIMEOUT',statusCode:504,cause:error});
  throw error;
 } finally {clearTimeout(timer);}
}
module.exports={withSqlDeadline};
