function numbers(text){return [...String(text).matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map(match=>Number(match[0].replaceAll(',',''))).filter(Number.isFinite);}
function groundExplanation(result,evidence,question){
  const allowed=new Set(numbers(question));
  for(const item of evidence)for(const row of item.rows||[])for(const value of Object.values(row)){
    if(typeof value==='number'&&Number.isFinite(value)){allowed.add(value);allowed.add(Math.round(value));allowed.add(Number(value.toFixed(2)));}
    else if(typeof value==='string')for(const number of numbers(value))allowed.add(number);
  }
  const claims=[result.answer,...result.highlights||[],...result.actions||[]].join(' ');
  if(numbers(claims).every(number=>allowed.has(number)))return result;
  const totals=evidence.find(item=>item.id==='totals')||evidence[0];
  const row=totals?.rows?.[0];
  const facts=row?Object.entries(row).slice(0,10).map(([key,value])=>`${key}: ${typeof value==='number'?value.toLocaleString('en-PK',{maximumFractionDigits:2}):String(value??'N/A')}`):[];
  return {answer:facts.length?`Database ke calculated figures: ${facts.join('; ')}.`:'Selected scope ke liye matching records nahi mile.',highlights:[],actions:[],suggestions:result.suggestions||[],confidence:row?'high':'low'};
}
module.exports={groundExplanation};
