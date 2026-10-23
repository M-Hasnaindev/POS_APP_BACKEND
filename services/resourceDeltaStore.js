// Retired intentionally: no environment setting may recreate/connect a sync DB.
const unavailable=()=>{throw Object.assign(new Error('Server sync storage is retired; use local sync.'),{status:410,code:'LOCAL_SYNC_REQUIRED'});};
module.exports={enabled:()=>false,initialize:unavailable,pool:unavailable,step:unavailable,changes:unavailable,close:async()=>{}};
