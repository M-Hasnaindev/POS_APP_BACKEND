const assert=require('node:assert/strict');
const jwt=require('jsonwebtoken');
const tenantPath=require.resolve('../config/tenants');
const restrictionPath=require('node:path').resolve(__dirname,'../middleware/accessRestriction.js');
require.cache[tenantPath]={id:tenantPath,filename:tenantPath,loaded:true,exports:{getTenantById:id=>id==='t1'}};
let restrictionCalls=0;
require.cache[restrictionPath]={id:restrictionPath,filename:restrictionPath,loaded:true,exports:{enforceAccess:async()=>{restrictionCalls++;throw Error('Admin store unavailable');}}};
process.env.JWT_SECRET='test-only-recovery-signature-secret';
const {accessStatus,verifyToken}=require('../middleware/authMiddleware');
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}});
(async()=>{
  const token=jwt.sign({type:'access',tenantId:'t1',userId:'u1',companyCode:'',exp:Math.floor(Date.now()/1000)-60},process.env.JWT_SECRET,{algorithm:'HS256'});
  const req={headers:{authorization:'Bearer '+token}};
  let res=response();await accessStatus(req,res);assert.equal(res.data.allowed,false);assert.equal(res.data.reauthenticate,true);
  res=response();let next=false;await verifyToken(req,res,()=>next=true);assert.equal(res.statusCode,401);assert.equal(next,false);
  const valid=jwt.sign({type:'access',tenantId:'t1',userId:'u1',companyCode:''},process.env.JWT_SECRET,{expiresIn:'1h'});
  res=response();await accessStatus({headers:{authorization:'Bearer '+valid}},res);assert.equal(res.data.allowed,true);assert.equal(res.data.reauthenticate,false);
  res=response();next=false;await verifyToken({headers:{authorization:'Bearer '+valid}},res,()=>next=true);assert.equal(next,true);
  res=response();await accessStatus({headers:{authorization:'Bearer '+token+'x'}},res);assert.equal(res.statusCode,401);
  for(const identity of [{type:'tenant',tenantId:'t1'}, {type:'access',tenantId:'missing',userId:'u1'}, {type:'access',tenantId:'t1',userId:'u1'}]) {
    const invalid=jwt.sign(identity,process.env.JWT_SECRET,{expiresIn:'1h'});
    res=response();next=false;await verifyToken({headers:{authorization:'Bearer '+invalid}},res,()=>next=true);assert.equal(res.statusCode,401);assert.equal(next,false);
  }
  assert.equal(restrictionCalls,0);
  console.log('Expired-token access recovery tests passed (mock guard; no database writes).');
})().catch(e=>{console.error(e);process.exitCode=1;});
