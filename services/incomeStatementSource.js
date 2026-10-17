const {sql}=require('../config/db');
const {stockValuation}=require('./incomeStockValuation');
const fail=message=>Object.assign(new Error(message),{statusCode:422,code:'INCOME_SOURCE_INCOMPLETE'});
const money=n=>Math.round(n*100)/100;
function number(row,key){if(row[key]===null||row[key]===undefined||!Number.isFinite(Number(row[key])))throw fail('Income Statement source is missing '+key);return Number(row[key]);}
function validateIncomeProfile(rows){
 const controls=[['401010001',/^SALES? ACCOUNT$/i,'4'],['401020001',/^SALES? RETURN(?: ACCOUNT)?$/i,'4'],['401030001',/^SALES? DISCOUNT(?: ACCOUNT)?$/i,'4'],['501010001',/^PURCHASE(?:S)? ACCOUNT$/i,'5'],['501020001',/^PURCHASE(?:S)? RETURN(?: ACCOUNT)?$/i,'5'],['501020002',/^PURCHASE(?:S)? DISCOUNT(?: ACCOUNT)?$/i,'5']];
 for(const[code,name,nature]of controls){const row=rows.find(r=>String(r.ActCod).trim()===code);if(!row||!name.test(String(row.AcName||'').trim())||String(row.AcNature).trim()!==nature)throw Object.assign(new Error('This company needs a verified Income Statement chart-of-accounts mapping.'),{statusCode:422,code:'INCOME_MAPPING_REQUIRED'});}
}
function assembleIncomeStatement({rows,columnMappings,params,options},stock){
 validateIncomeProfile(rows);
 const codes=params[16].split(',').filter(Boolean);const mappings=columnMappings.branches||[];
 const branches=codes.map(branchCode=>{
  const mapping=mappings.find(r=>String(r.BranchCode).trim()===branchCode);
  const name=options.branches.find(r=>String(r.BranchCode).trim()===branchCode)?.BranchName||branchCode;
  const valuation=stock.get(branchCode);if(!valuation)throw fail('A complete stock valuation was not returned for '+name+'.');
  const accounts=[];
  if(!mapping&&rows.some(r=>!Object.hasOwn(r,'BranchCode')))throw fail('Accounting branch mapping was not returned for '+name+'.');
  for(const row of rows){
   if(!['4','5'].includes(String(row.AcNature).trim()))continue;
   const direct=Object.hasOwn(row,'BranchCode');if(direct&&String(row.BranchCode).trim()!==branchCode)continue;
   const suffix=direct?'':String(mapping.Row);
   const movement=money(number(row,'TDebit'+suffix)-number(row,'TCredit'+suffix));
   const code=String(row.ActCod??'').trim();if(!code)throw fail('Accounting source is missing an account code.');
   const levels=[1,2,3,4,5,6,7].map(i=>({code:String(row['Level'+i+'Code']??'').trim(),name:String(row['Level'+i+'Name']??'').trim()})).filter(l=>l.code&&l.code!==code);
   const group=levels.at(-1)||{};
   accounts.push({code,name:String(row.AcName||code),movement,groupCode:group.code||String(row.GrpCod||''),groupName:String(row.GrpName||group.name||'').replace(/^\S+ - /,''),nature:String(row.AcNature||''),levels});
  }
  return {branchCode,branchName:name,...valuation,accounts};
 });
 return {branches,fromDate:params[1],toDate:params[2],source:'AccProc I account movements + POSStockMovement valuation method 3',valuationMethod:'3'};
}
async function loadIncomeStatement(pool,input){
 validateIncomeProfile(input.rows);
 const deadline=input.deadline??Date.now()+250000;
 const {params,options}=input;const start=options.companyStart;
 if(!start||start>params[1])throw fail('The accounting opening date does not cover this reporting period.');
 // Release the accounting procedure lock before slow historical stock reads.
 // Each stock procedure's working-table mutations are rolled back independently.
 async function read(toDate,fromDate=toDate){if(Date.now()>=deadline)throw Object.assign(new Error('Income Statement timed out. Please retry with fewer branches.'),{statusCode:504,code:'INCOME_SOURCE_TIMEOUT'});const transaction=new sql.Transaction(pool);let begun=false;try{await transaction.begin();begun=true;const result=await stockValuation(transaction,{companyCode:params[14],branchCodes:params[16].split(',').filter(Boolean),fromDate,toDate,timeoutMs:Math.max(1,deadline-Date.now())});await transaction.rollback();begun=false;return result;}finally{if(begun)await transaction.rollback().catch(()=>undefined);}}
 const stock=await read(params[2],params[1]===start?start:params[2]);
 if(params[1]!==start){const previous=new Date(params[1]+'T00:00:00Z');previous.setUTCDate(previous.getUTCDate()-1);const opening=await read(previous.toISOString().slice(0,10));for(const [code,value]of stock){if(!opening.has(code))throw fail('Opening-date stock valuation was not returned for '+code+'.');value.openingInventory=opening.get(code).closingInventory;}}
 return assembleIncomeStatement(input,stock);
}
module.exports={loadIncomeStatement,stockValuation,assembleIncomeStatement,validateIncomeProfile};
