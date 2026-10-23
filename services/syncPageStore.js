// Legacy entry points deliberately cannot connect to or create a database.
const retired=async()=>{throw Object.assign(new Error('Update the app to use local sync.'),{statusCode:410,code:'LOCAL_SYNC_REQUIRED'});};
module.exports=Object.fromEntries(['startJob','findJob','readPage','waitForJob','saveMetadata','storePage','completeJob','failJob','claimStep'].map(name=>[name,retired]));
