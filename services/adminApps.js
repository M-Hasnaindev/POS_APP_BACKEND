const crypto = require('node:crypto');
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const {fail} = require('./adminStore');
const local = {id:'pos',name:'POS',kind:'local',baseUrl:'',secretConfigured:true,restrictionsEnabled:false};
function key() {
  const raw = process.env.ADMIN_CONNECTOR_ENCRYPTION_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw fail('Configure ADMIN_CONNECTOR_ENCRYPTION_KEY before adding apps.',503);
  return Buffer.from(raw,'hex');
}
function encrypt(secret,id) {
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
  cipher.setAAD(Buffer.from(id));
  const data=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),data.toString('base64')].join('.');
}
function decrypt(value,id) {
  const [version,iv,tag,data]=value.split('.');
  if(version!=='v1') throw fail('App connection must be configured again.',503);
  const cipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(iv,'base64'));
  cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]).toString('utf8');
}
function publicAddress(address) {
  // Use globally routed IPv4 only. Reject IPv6 (including IPv4-mapped forms).
  if(net.isIP(address)!==4) return false;
  const [a,b]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||b===51))||(a===203&&b===0));
}
function validateUrl(value) {
  let url; try {url=new URL(value);} catch {throw fail('Enter a valid HTTPS backend URL.');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||(url.port&&url.port!=='443')||net.isIP(url.hostname)||!url.hostname.includes('.')||url.hostname.endsWith('.local')) throw fail('Use a public HTTPS backend URL without credentials, query or custom port.');
  return url.toString().replace(/\/+$/,'');
}
function connectorFailure(status) {
  if(status===401||status===403) return fail('App connector authentication failed. Check the configured connector key.',502,'APP_CONNECTOR_AUTH_FAILED');
  if(status===503) return fail('This app cannot access its company database or access-control storage. Please retry after its backend is available.',503,'APP_CONNECTOR_STORAGE_UNAVAILABLE');
  if(status===404) return fail('This app backend does not provide the requested admin connector endpoint. Check its deployment.',502,'APP_CONNECTOR_ENDPOINT_MISSING');
  return fail('App connector rejected the request. Check its configuration and status.',502,'APP_CONNECTOR_REJECTED');
}
async function connector(app,path,body) {
  const base=validateUrl(app.baseUrl), url=new URL(base+path);
  const addresses=await dns.lookup(url.hostname,{all:true,family:4});
  if(!addresses.length||addresses.some(x=>!publicAddress(x.address))) throw fail('Backend address is not public.',400);
  const pinned=addresses[0];
  return new Promise((resolve,reject)=>{
    const request=https.request(url,{method:body?'PUT':'GET',agent:false,lookup:(_host,options,cb)=>options.all?cb(null,[pinned]):cb(null,pinned.address,4),headers:{Authorization:'Bearer '+decrypt(app.secretCipher,app.id),'Content-Type':'application/json',Accept:'application/json'}},response=>{
      let bytes=0,parts=[];
      response.on('data',part=>{bytes+=part.length;if(bytes>5*1024*1024){response.destroy();reject(fail('App response is too large.',502));}else parts.push(part);});
      response.on('error',()=>reject(fail('App connection interrupted.',502)));
      response.on('end',()=>{
        if(response.statusCode<200||response.statusCode>=300) return reject(connectorFailure(response.statusCode));
        try {const result=JSON.parse(Buffer.concat(parts).toString('utf8'));if(result.success!==true)throw Error();resolve(result);}catch {reject(fail('App connector returned an invalid response.',502));}
      });
    });
    request.setTimeout(15000,()=>request.destroy());
    request.on('error',()=>reject(fail('Cannot connect to app backend.',502)));
    if(body) request.write(JSON.stringify(body)); request.end();
  });
}
const safe = app => app.id==='pos'?local:({id:app.id,name:app.name,kind:'connector',baseUrl:app.baseUrl,secretConfigured:Boolean(app.secretCipher),updatedAt:app.updatedAt});
const segment=value=>encodeURIComponent(String(value));
function createApps(store,dir,remote=connector) {
  async function get(id) {if(id==='pos')return local;const app=(await store.apps()).find(x=>x.id===id);if(!app)throw fail('App not found.',404);return app;}
  async function companies(app) {const r=await remote(app,'/api/admin-connector/companies');if(!Array.isArray(r.companies))throw fail('Invalid company directory.',502);return r.companies;}
  async function tenants(id) {const app=await get(id);return id==='pos'?dir.tenants.map(dir.tenantSummary):(await companies(app)).map(c=>({id:String(c.id),label:c.name,key:'••••••••',restricted:!!c.restricted,reason:c.reason||''}));}
  async function detail(id,tenantId) {
    const app=await get(id);
    if(id==='pos')return {...await dir.detail(tenantId),restrictions:[],restrictionsEnabled:false};
    const company=(await companies(app)).find(c=>String(c.id)===tenantId);if(!company)throw fail('Company not found.',404);
    const result=await remote(app,'/api/admin-connector/companies/'+segment(tenantId)+'/users');
    if(!Array.isArray(result.users))throw fail('Invalid employee directory.',502);
    const restriction=(scope,userId,restricted,reason)=>({tenantId,companyCode:'',scope,userId,restricted:!!restricted,reason:reason||''});
    return {tenant:{id:tenantId,label:company.name,key:'••••••••'},companies:[{companyCode:'',name:company.name,userCount:result.users.length}],users:result.users.map(u=>({companyCode:'',userId:String(u.id),displayName:u.name,userType:u.department||'',email:'',mobile:'',branch:u.branch||''})),restrictions:[restriction('tenant','',company.restricted,company.reason),...result.users.map(u=>restriction('user',String(u.id),u.restricted,u.reason))]};
  }
  async function restrict(id,row,actor) {
    const app=await get(id);
    if(id==='pos')throw fail('Admin restrictions are disabled for POS.',410,'POS_RESTRICTIONS_DISABLED');
    if(row.companyCode)throw fail('This app uses tenant-level companies.');
    const data=await detail(id,row.tenantId);
    if(row.scope==='user'&&!data.users.some(u=>u.userId===row.userId))throw fail('User not found.',404);
    const path='/api/admin-connector/companies/'+segment(row.tenantId)+(row.scope==='user'?'/users/'+segment(row.userId):'')+'/access';
    await store.audit(actor,'app.restriction.requested',JSON.stringify({appId:id,...row,reason:undefined}).slice(0,500));
    await remote(app,path,{restricted:row.restricted,reason:row.reason});
    await store.audit(actor,'app.restriction.applied',id+':'+row.tenantId+':'+row.userId);
  }
  async function save(body,actor,id) {
    const create=!id; id=id||body.id;
    if(typeof id!=='string'||! /^[a-z][a-z0-9-]{1,63}$/.test(id)||id==='pos')throw fail('Use an app ID with 2–64 lowercase letters, numbers or hyphens. POS is reserved.');
    const prior=(await store.apps()).find(a=>a.id===id);
    if(create&&prior)throw fail('App ID already exists.',409);
    if(!create&&!prior)throw fail('App not found.',404);
    const name=body.name??prior?.name,baseUrl=validateUrl(body.baseUrl??prior?.baseUrl);
    if(typeof name!=='string'||!name.trim()||name.length>100)throw fail('Enter an app name up to 100 characters.');
    let secretCipher=prior?.secretCipher;
    if(body.connectorSecret!==undefined){if(typeof body.connectorSecret!=='string'||body.connectorSecret.length<32||body.connectorSecret.length>512||/[\r\n]/.test(body.connectorSecret))throw fail('Connector key must contain 32–512 characters.');secretCipher=encrypt(body.connectorSecret,id);}
    if(!secretCipher)throw fail('A connector key is required.');
    // Do not persist a misconfigured connection; also validates DNS and credentials.
    const app={id,name:name.trim(),baseUrl,secretCipher};await companies(app);
    await store.saveApp(app,actor,create);return safe(app);
  }
  async function revealKey(id,tenantId,actor) {
    const app=await get(id);
    const tenant=id==='pos'?dir.getTenantById(tenantId):(await companies(app)).find(c=>String(c.id)===tenantId);
    if(!tenant)throw fail('Tenant not found.',404);
    await store.audit(actor,'app.tenant.key.revealed',id+':'+tenantId);
    return id==='pos'?tenant.key:tenant.tenantKey||'';
  }
  return {list:async()=>[local,...(await store.apps()).map(safe)],get,tenants,detail,restrict,save,revealKey};
}
module.exports={createApps,connector,connectorFailure,validateUrl,publicAddress,encrypt,decrypt,safe};
