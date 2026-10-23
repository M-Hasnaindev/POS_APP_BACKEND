const crypto = require('node:crypto');
const { once } = require('node:events');
async function sendSyncStream(req, res, run) {
    const abort = new AbortController();
    const close = () => { if (!res.writableEnded)
        abort.abort(); };
    res.on('close', close);
    res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.set('X-Accel-Buffering', 'no');
    res.flushHeaders();
    let count = 0, sequence = 0;
    const write = async (event) => { if (abort.signal.aborted)
        throw new Error('Download disconnected'); if (!res.write(JSON.stringify(event) + '\n'))
        await once(res, 'drain', { signal: abort.signal }); };
    const heartbeat = setInterval(() => { if (!abort.signal.aborted && !res.writableNeedDrain)
        res.write('{"type":"progress"}\n'); }, 10000);
    try {
        const metadata = await run(async (rows) => { const checksum = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); await write({ type: 'batch', sequence: sequence++, rows, checksum }); count += rows.length; }, abort.signal);
        await write({ type: 'complete', ...metadata, count, batches: sequence, generatedAt: new Date().toISOString() });
    }
    catch (error) {
        if (!abort.signal.aborted)
            await write({ type: 'error', message: 'Sync did not complete. Your previous data is safe; please retry.' }).catch(() => { });
    }
    finally {
        clearInterval(heartbeat);
        res.off('close', close);
        res.end();
    }
}
module.exports = { sendSyncStream };
