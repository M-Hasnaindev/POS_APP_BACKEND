// Conservative language adapter. Unknown names, filters or complex requests are
// left to the schema-aware planner instead of silently returning an overall total.
const day=86400000;
const iso=time=>new Date(time).toISOString().slice(0,10);
function normalize(value){return String(value||'').toLowerCase().replace(/\b(aaj|aj)\b/g,'today').replace(/\b(sale|salse|salles|farokht)\b/g,'sales').replace(/\b(purchasing|purchse|kharidari)\b/g,'purchase').replace(/\b(pichlay|pichle|pichla)\b/g,'last').replace(/\b(iss|is|as) (month|mahine|mahina)\b/g,'this month').replace(/\b(tafseel|tafseeli|detail)\b/g,'detailed').replace(/\b(mukhtasar)\b/g,'short').replace(/[?!,]/g,' ').replace(/\s+/g,' ').trim();}
function resolveIntent(question,previous=null,today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())){
 let rest=normalize(question),domain=null,dimension=null,fromDate=null,toDate=null;
 const consume=(pattern,fn)=>{rest=rest.replace(pattern,(...args)=>{fn?.(...args);return ' ';});};
 const detailLevel=/\b(short|brief|sirf|total)\b/.test(rest)?'short':/\b(detailed|explain|samjhao)\b/.test(rest)?'detailed':previous?.detailLevel||'short';
 if(/\bkal\b/.test(rest))return {clarification:'Kal se aap yesterday murad le rahe hain ya tomorrow?'};
 if(/\bpurchase returns?\b/.test(rest))consume(/\bpurchase returns?\b/g,()=>domain='purchase-return');
 else if(/\bpurchase\b/.test(rest))consume(/\bpurchase\b/g,()=>domain='purchase');
 else if(/\bsales\b/.test(rest))consume(/\bsales\b/g,()=>domain='sales');
 for(const dim of ['branch','store','brand','category','season','barcode','design','supplier','day','week','month']){
   const re=new RegExp(`\\b${dim}[- ]wise\\b`,'g');
   if(re.test(rest)){dimension=dim;consume(re);}
 }
 const now=Date.parse(today),year=Number(today.slice(0,4)),month=Number(today.slice(5,7));
 consume(/\b(\d{4}-\d{2}-\d{2})\s+(?:to|se)\s+(\d{4}-\d{2}-\d{2})\b/,(_m,a,b)=>{fromDate=a;toDate=b;});
 consume(/\blast (\d{1,3}) (?:days|din)\b/,(_m,n)=>{fromDate=iso(now-(Number(n)-1)*day);toDate=today;});
 consume(/\blast month\b/,()=>{fromDate=iso(Date.UTC(year,month-2,1));toDate=iso(Date.UTC(year,month-1,0));});
 consume(/\bthis month\b/,()=>{fromDate=today.slice(0,7)+'-01';toDate=today;});
 consume(/\b(?:year to date|ytd|this year|is saal)\b/,()=>{fromDate=today.slice(0,4)+'-01-01';toDate=today;});
 consume(/\byesterday\b/,()=>{fromDate=toDate=iso(now-day);});
 consume(/\btoday\b/,()=>{fromDate=toDate=today;});
 consume(/\b(?:bhai|brother|please|plz|mujhe|meri|mera|ki|ka|ke|ko|hai|hain|h|batao|bata|do|dikhao|show|me|tell|total|short|brief|detailed|mein|main|samjhao|explain|sirf|aur|and|what|were|the)\b/g);
 if(rest.trim())return null; // e.g. "Lahore", "profit", "top 5" must not be dropped
 const explicitDomain=domain;
 domain=domain||previous?.domain;
 if(!domain)return null;
 if(!fromDate&&!toDate){fromDate=previous?.fromDate;toDate=previous?.toDate;}
 if(!fromDate||!toDate)return {clarification:'Kis period ka data chahiye—today, this month, ya date range?'};
 const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&iso(Date.parse(value))===value;
 if(!valid(fromDate)||!valid(toDate)||fromDate>toDate||toDate>today)return {clarification:'Actual data ke liye valid past/today date range batayein.'};
 dimension=dimension||(explicitDomain&&explicitDomain!==previous?.domain?null:previous?.dimension)||null;
 const sales={branch:5,store:6,barcode:8,design:9,brand:10,category:12,season:17,day:2,week:3,month:4};
 const purchases={supplier:3,barcode:4,design:5,brand:6,category:7};
 const catalog=require('../ai/businessReportCatalog.json');
 let prefix;
 if(domain==='sales'){if(dimension&&!sales[dimension])return null;prefix=`RPT_02_${String(dimension?sales[dimension]:1).padStart(3,'0')}_`;}
 else if(domain==='purchase'){if(dimension&&!purchases[dimension])return null;prefix=`RPT_05_${String(dimension?purchases[dimension]:1).padStart(3,'0')}_`;}
 else {if(dimension&&dimension!=='supplier')return null;prefix='RPT_05_009_';}
 const report=catalog.find(item=>item.code.startsWith(prefix));if(!report)return null;
 return {domain,dimension,fromDate,toDate,detailLevel,code:report.code};
}
function resolveConversation(question,history=[],today){
 let context=null;
 const users=history.filter(item=>item.role==='user').slice(-10);
 if(users.at(-1)?.content===question)users.pop();
 for(const item of users){const resolved=resolveIntent(item.content,context,today);context=resolved&&!resolved.clarification?resolved:null;}
 return resolveIntent(question,context,today);
}
module.exports={normalize,resolveIntent,resolveConversation};
