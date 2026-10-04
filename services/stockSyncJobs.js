const { waitUntil } = require('@vercel/functions');
const { getPoolForTenant } = require('../config/db');
const { getStockSnapshot, resolveCompanyCode } = require('./stockSnapshotService');
const store = require('./syncPageStore');

function publicStockJob(job) {
  return { jobId: job.jobId, status: job.status, count: job.count, sourceCount: job.sourceCount, generatedAt: job.generatedAt, error: job.error };
}
function schedule(job) {
  // A transient polling/storage failure must not become an unhandled rejection
  // or terminate other tenants' requests. The next poll resumes the job.
  waitUntil(advance(job).catch(error => console.error('[StockSyncJobs] Coordinator:', error.code || error.name)));
}
async function startStockJob(options) {
  const pool = await getPoolForTenant(options.tenantId);
  const companyCode = await resolveCompanyCode(pool, options);
  const resolved = { ...options, companyCode };
  const job = await store.startJob('stock-ranges-v1', resolved, null);
  if (job.status === 'processing' && !job.metadata.options && await store.claimStep(job.jobId)) {
    // Partition the same BarcodeView used by the procedure. SQL collation and
    // inclusive MIN/MAX boundaries ensure no overlaps and no skipped products.
    // All branches/stores stay inside each partition, including historical ones.
    const ranges = await pool.request().query(`
      WITH Codes AS (SELECT DISTINCT BarCode FROM dbo.BarcodeView WHERE BarCode IS NOT NULL),
      Numbered AS (SELECT BarCode, (ROW_NUMBER() OVER(ORDER BY BarCode)-1)/2000 AS Bucket FROM Codes)
      SELECT MIN(BarCode) barcodeFrom,MAX(BarCode) barcodeTo FROM Numbered GROUP BY Bucket ORDER BY Bucket`);
    job.metadata = { options: resolved, branches: ranges.recordset.map((_,i)=>String(i)), ranges: ranges.recordset, children: {} };
    if (!ranges.recordset.length) {
      await store.completeJob(job.jobId, 0, 0);
      return publicStockJob(await store.findJob(job.jobId, options.tenantId, options.userId));
    }
    await store.saveMetadata(job.jobId, job.metadata);
  }
  if (job.status === 'processing') schedule(job);
  return publicStockJob(job);
}
async function getStockJob(jobId, tenantId, userId) {
  const job = await store.findJob(jobId, tenantId, userId);
  if (job?.status === 'processing') schedule(job);
  return job ? publicStockJob(job) : null;
}

async function advance(job) {
  if (!job.metadata.options || !await store.claimStep(job.jobId)) return;
  job = await store.findJob(job.jobId, job.metadata.options.tenantId, job.metadata.options.userId);
  if (!job || job.status !== 'processing') return;
  const metadata = { ...job.metadata, children: { ...job.metadata.children } };
  try {
    const children = new Map();
    await Promise.all(metadata.branches.map(async branch => {
      children.set(branch, metadata.children[branch] ? await store.findJob(metadata.children[branch], metadata.options.tenantId, metadata.options.userId) : null);
    }));
    let running = [...children.values()].filter(child => child?.status === 'processing').length;
    const ready = [];
    for (const branch of metadata.branches) {
      let child = children.get(branch);
      if (child?.status === 'failed') throw new Error(`Stock branch job failed: ${branch}`);
      if (child?.status === 'ready') ready.push(child);
      if (!child && running < 3) {
        const options = { ...metadata.options, ...metadata.ranges[Number(branch)] };
        child = await store.startJob('stock-range-v1', options, onBatch => getStockSnapshot(options, onBatch));
        metadata.children[branch] = child.jobId;
        if (child.status === 'ready') ready.push(child); else running += 1;
      }
    }
    if (ready.length === metadata.branches.length) {
      // Stitch final branch remainders into fixed 5,000-row download pages.
      let carry = [], page = 0, count = 0, source = 0;
      for (const child of ready) {
        source += child.sourceCount;
        for (let p = 1; ; p++) {
          const batch = await store.readPage(child, p);
          carry.push(...batch.data); count += batch.count;
          if (carry.length >= 5000) await store.storePage(job.jobId, ++page, carry.splice(0, 5000));
          if (!batch.hasMore) break;
        }
      }
      if (carry.length) await store.storePage(job.jobId, ++page, carry);
      await store.completeJob(job.jobId, count, source);
    } else {
      delete metadata.lease;
      await store.saveMetadata(job.jobId, metadata);
    }
  } catch (error) {
    console.error('[StockSyncJobs]', job.metadata.options.tenantId, error.message);
    await store.failJob(job.jobId);
  }
}
module.exports = { startStockJob, getStockJob };
