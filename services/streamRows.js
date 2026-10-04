// Consume one SQL recordset with backpressure. Never materialize the whole
// procedure result in the driver, including rows discarded by the filter.
async function streamRows(request, execute, onBatch, accept = () => true) {
  request.stream = true;
  let batch = [], sourceCount = 0, count = 0, recordset = 0;
  let flushing = Promise.resolve();
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = error => { if (failed) return; failed = true; request.cancel(); reject(error); };
    const flush = () => {
      const rows = batch; batch = [];
      flushing = flushing.then(() => onBatch(rows));
      return flushing;
    };
    request.on('recordset', () => { recordset += 1; });
    request.on('row', row => {
      if (failed || recordset > 1) return;
      sourceCount += 1;
      if (!accept(row)) return;
      batch.push(row); count += 1;
      if (batch.length === 5000) {
        request.pause();
        flush().then(() => { if (!failed) request.resume(); }).catch(fail);
      }
    });
    request.on('error', fail);
    request.on('done', () => {
      if (failed) return;
      (batch.length ? flush() : flushing).then(() => resolve({ sourceCount, count })).catch(fail);
    });
    try { Promise.resolve(execute()).catch(fail); } catch (error) { fail(error); }
  });
}
module.exports = { streamRows };
