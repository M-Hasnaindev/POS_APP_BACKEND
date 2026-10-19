const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const path = require('node:path');
const setModule = (relative, exports) => {
  const id = require.resolve(relative);
  require.cache[id] = {id, filename:id, loaded:true, exports};
};
let adminCalls = 0;
const retired = path.resolve(__dirname, '../middleware/accessRestriction.js');
require.cache[retired] = {id:retired,filename:retired,loaded:true,exports:{enforceAccess:async()=>{adminCalls++;throw Error('Admin store unavailable');}}};
setModule('../config/tenants', {
  getTenantById:id=>id==='t1'?{id,label:'Test'}:null,
  getPublicTenant:tenant=>tenant,
});
setModule('../config/db', {
  sql:{VarChar:'varchar'},
  getPoolForTenant:async()=>({request(){
    const params={};
    return {input(key,type,value){params[key]=value;return this;},async query(text){
      if(text.includes('FROM Security')) return {recordset:params.pinCode==='1234'?[{CompanyCode:'C1',UserID:'user1',UserType:'U',PinCode:'1234',AllowBranches:'N'}]:[]};
      return {recordset:[{AccountName:'Test company'}]};
    }};
  }}),
});
process.env.JWT_SECRET='test-only-login-retirement-secret';
const {login}=require('../controllers/authController');
const response=()=>({statusCode:200,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});
(async()=>{
  const tenantToken=jwt.sign({type:'tenant',tenantId:'t1'},process.env.JWT_SECRET,{expiresIn:'1h'});
  let res=response();await login({body:{pinCode:'1234',tenantToken}},res);
  assert.equal(res.body.success,true);
  const identity=jwt.verify(res.body.token,process.env.JWT_SECRET);
  assert.equal(identity.tenantId,'t1');assert.equal(identity.userId,'user1');assert.equal(identity.companyCode,'C1');
  assert.equal(res.body.user.PinCode,undefined);
  res=response();await login({body:{pinCode:'wrong',tenantToken}},res);assert.equal(res.statusCode,401);
  res=response();await login({body:{pinCode:'1234',tenantToken:tenantToken+'x'}},res);assert.equal(res.statusCode,401);
  assert.equal(adminCalls,0);
  console.log('PIN login remains authenticated and independent of retired admin restriction storage.');
})().catch(error=>{console.error(error);process.exitCode=1;});
