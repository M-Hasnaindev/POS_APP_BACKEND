const assert = require('node:assert/strict');
const background = [];
const jobs = new Map(), pages = new Map();
let sequence = 0, peakRunning = 0, running = 0, fail = false, selectedRangeSize = 0;
const counts = [6501, 0, 2400, 5000, 1];
const ranges = counts.map((_, i) => ({ barcodeFrom: String(i), barcodeTo: String(i) }));
const copy = value => value && structuredClone(value);
function mock(name, exports) { require.cache[require.resolve(name)] = { id: name, filename: name, loaded: true, exports }; }
mock('@vercel/functions', { waitUntil: work => background.push(work) });
mock('../config/db', { sql:{VarChar:()=>null,Int:null},getPoolForTenant: async () => ({ request: () => ({ input(name,_type,value){if(name==='rangeSize')selectedRangeSize=value;return this;},query: async text => ({ recordset: text.includes('dbo.Defaults')?[{transit:'Y',zeroSeeds:1}]:ranges }) }) }) });
mock('../services/stockSnapshotService', {
  resolveCompanyCode: async () => 'TEST',
  getStockSnapshot: async (options, sink) => {
    running++; peakRunning = Math.max(peakRunning, running);
    try {
      await new Promise(resolve => setImmediate(resolve));
      if (fail) throw Error('database unavailable');
      const count = counts[Number(options.barcodeFrom)];
      for (let start = 0; start < count; start += 5000) await sink(Array.from({ length: Math.min(5000, count - start) }, (_, i) => ({ id: `${options.barcodeFrom}-${start + i}` })));
      return { sourceCount: count + 10 };
    } finally { running--; }
  },
});
mock('../services/syncPageStore', {
  startJob: async (kind, options, run) => {
    const key = JSON.stringify([kind, options]);
    const existing = [...jobs.values()].find(job => job.key === key && job.status !== 'failed');
    if (existing) return copy(existing);
    const job = { jobId: String(++sequence), key, status: 'processing', count: 0, sourceCount: 0, metadata: {}, options };
    jobs.set(job.jobId, job); pages.set(job.jobId, []);
    if (run) background.push((async () => {
      try {
        const result = await run(async rows => { pages.get(job.jobId).push(rows); job.count += rows.length; });
        job.sourceCount = result.sourceCount; job.status = 'ready';
      } catch { job.status = 'failed'; }
    })());
    return copy(job);
  },
  findJob: async (id, tenant, user) => { const job=jobs.get(id); return job?.options.tenantId===tenant && job?.options.userId===user ? copy(job) : null; },
  claimStep: async id => { const job=jobs.get(id); if(job.lock || job.status!=='processing')return false;job.lock=true;return true; },
  saveMetadata: async (id, metadata) => { const job=jobs.get(id);job.metadata=copy(metadata);job.lock=false; },
  storePage: async (id,page,rows) => { pages.get(id)[page-1]=copy(rows); },
  completeJob: async (id,count,sourceCount) => Object.assign(jobs.get(id),{status:'ready',count,sourceCount}),
  failJob: async id => { jobs.get(id).status='failed'; },
  readPage: async (job,page) => { const data=pages.get(job.jobId)[page-1]||[];return {data,count:data.length,hasMore:page<pages.get(job.jobId).length}; },
});
const { startStockJob,getStockJob }=require('../services/stockSyncJobs');
async function drain() { while(background.length) await Promise.all(background.splice(0)); }
(async()=>{
 const options={tenantId:'test-tenant',userId:'test-user',fromDate:'2026-01-01',toDate:'2026-10-04'};
 const [first,second]=await Promise.all([startStockJob(options),startStockJob(options)]);
 assert.equal(first.jobId,second.jobId);
 for(let i=0;i<10;i++) { await drain(); await Promise.all(Array.from({length:3},()=>getStockJob(first.jobId,options.tenantId,options.userId))); }
 await drain();
 const job=await getStockJob(first.jobId,options.tenantId,options.userId);
 assert.equal(job.status,'ready');assert.equal(job.count,13902);assert.equal(job.sourceCount,13952);
 const output=pages.get(first.jobId);assert.deepEqual(output.map(page=>page.length),[5000,5000,3902]);
 assert.equal(selectedRangeSize,5000);
 assert.equal(new Set(output.flat().map(row=>row.id)).size,13902);assert(peakRunning<=4);
 assert.equal(await getStockJob(first.jobId,'other-tenant',options.userId),null);
 assert.equal(await getStockJob(first.jobId,options.tenantId,'other-user'),null);
 fail=true;
 const broken=await startStockJob({...options,tenantId:'broken'});await drain();
 await getStockJob(broken.jobId,'broken',options.userId);await drain();
 assert.equal((await getStockJob(broken.jobId,'broken',options.userId)).status,'failed');
 console.log('PASS: concurrent start/polls, optimized 5000-barcode ranges, bounded workers, all-range merge, fixed 5000 pages, ownership, failures.');
})().catch(error=>{console.error(error);process.exitCode=1;});
