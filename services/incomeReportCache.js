// Per-pool, short-lived complete reports only. Call after current authorization
// and filter validation; never cache authentication, permission, or error results.
function createIncomeReportCache({ttlMs=60000,maxEntries=32,maxBytes=8*1024*1024,now=Date.now}={}) {
 const pools=new WeakMap();
 return async function cached(pool,key,load,{refresh=false}={}) {
  let state=pools.get(pool);
  if(!state){state={values:new Map(),pending:new Map(),bytes:0};pools.set(pool,state);}
  const remove=k=>{const old=state.values.get(k);if(old){state.bytes-=old.bytes;state.values.delete(k);}};
  for(const [k,value]of state.values)if(value.expires<=now())remove(k);
  if(!refresh){const hit=state.values.get(key);if(hit)return JSON.parse(hit.json);if(state.pending.has(key))return JSON.parse(await state.pending.get(key));}
  else remove(key);
  let pending;
  pending=Promise.resolve().then(load).then(result=>{
   const json=JSON.stringify(result),bytes=Buffer.byteLength(json);
   // A slower earlier request must not replace a more recent explicit refresh.
   if(state.pending.get(key)===pending&&bytes<=maxBytes){
    remove(key);
    while(state.values.size>=maxEntries||state.bytes+bytes>maxBytes)remove(state.values.keys().next().value);
    state.values.set(key,{json,bytes,expires:now()+ttlMs});state.bytes+=bytes;
   }
   return json;
  }).finally(()=>{if(state.pending.get(key)===pending)state.pending.delete(key);});
  state.pending.set(key,pending);
  return JSON.parse(await pending);
 };
}
module.exports={createIncomeReportCache};
