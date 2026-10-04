const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { streamRows } = require('../services/streamRows');
class Request extends EventEmitter {
  constructor(total) { super(); this.total=total; this.position=0; this.paused=false; this.cancelled=false; }
  pause() { this.paused=true; }
  resume() { this.paused=false; setImmediate(()=>this.pump()); }
  cancel() { this.cancelled=true; }
  execute() { this.emit('recordset',{}); setImmediate(()=>this.pump()); return Promise.resolve(); }
  pump() {
    while(!this.paused && !this.cancelled && this.position<this.total) this.emit('row',{id:this.position++});
    if(!this.paused && !this.cancelled && this.position===this.total) this.emit('done');
  }
}
(async()=>{
  for(const count of [0,1,5000,5001,25001]) {
    const request=new Request(count),sizes=[],ids=[];
    const result=await streamRows(request,()=>request.execute(),async rows=>{ await new Promise(r=>setTimeout(r,1));sizes.push(rows.length);ids.push(...rows.map(row=>row.id)); });
    assert.equal(result.count,count); assert.equal(result.sourceCount,count);
    assert.equal(ids.length,count); assert.equal(new Set(ids).size,count);
    assert(sizes.every((size,index)=>size===5000 || index===sizes.length-1));
  }
  const filtered=new Request(30000),sizes=[];
  const result=await streamRows(filtered,()=>filtered.execute(),async rows=>sizes.push(rows.length),row=>row.id%2===0);
  assert.equal(result.count,15000);assert.equal(result.sourceCount,30000);assert.deepEqual(sizes,[5000,5000,5000]);
  const broken=new Request(12000);
  await assert.rejects(streamRows(broken,()=>broken.execute(),async()=>{throw Error('storage failed');}),/storage failed/);
  assert(broken.cancelled);
  console.log('PASS: SQL streaming, backpressure, fixed 5000 batches, zero/partial pages, filtered rows and cancellation.');
})().catch(error=>{console.error(error);process.exitCode=1;});
