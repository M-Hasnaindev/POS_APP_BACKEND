const {compileSalesReport}=require('./salesSemanticCompiler');
const supported=code=>/^RPT_08_(00[1-9]|01[0-9]|020)_/.test(code);
const iso=time=>new Date(time).toISOString().slice(0,10);
const day=86400000;
function forecastWindow(report,filters){
  const start=Date.parse(filters.fromDate),end=Date.parse(filters.toDate);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw new Error('Invalid forecast period');
  const days=Math.round((end-start)/day)+1;
  const explicit=report.name.match(/Next (7|15|30|90) Days/i);
  const horizon=explicit?Number(explicit[1]):/Daily/i.test(report.name)?1:/Weekly/i.test(report.name)?7:/Monthly/i.test(report.name)?30:days;
  return {days,horizon,historyStart:iso(start-3*days*day),p2:iso(start-2*days*day),p1:iso(start-days*day),start:filters.fromDate,end:filters.toDate,futureStart:iso(end+day),futureEnd:iso(end+horizon*day)};
}
function compileForecastReport(report,schema,filters,permissions={},options={}){
  if(!supported(report.code))return null;
  const window=forecastWindow(report,filters),live=options.dialect==='mssql';
  // Time-grained titles select a horizon, not a grouping of unrelated historical
  // calendar dates. Merchandise/location forecasts keep their real dimensions.
  const dimension=['day','week','month'].includes(report.dimension)?null:report.dimension;
  const {base}=compileSalesReport({...report,code:'RPT_02_001_SALES_SUMMARY',dimension},schema,{...filters,fromDate:window.historyStart},permissions,{...options,factsOnly:true});
  const ranges={P1:`SaleDate>='${window.p1}' AND SaleDate<'${window.start}'`,P2:`SaleDate>='${window.p2}' AND SaleDate<'${window.p1}'`,P3:`SaleDate>='${window.historyStart}' AND SaleDate<'${window.p2}'`,Actual:`SaleDate>='${window.start}' AND SaleDate<='${window.end}'`};
  const aggregates=Object.entries(ranges).flatMap(([period,condition])=>[['Amount','NetSales'],['Qty','NetQuantity'],['Profit','NetSales-HistoricalCost'],['Rows','1']].map(([metric,value])=>`COALESCE(SUM(CASE WHEN ${condition} THEN ${value} ELSE 0 END),0) ${period}${metric}`)).join(',');
  const raw=Object.keys(ranges).flatMap(period=>['Amount','Qty','Profit','Rows'].map(metric=>period+metric));
  const historyRows='(P1Rows+P2Rows+P3Rows)';
  const forecast=metric=>`CASE WHEN ${historyRows}=0 THEN NULL ELSE (P1${metric}+P2${metric}+P3${metric})*1.0/${3*window.days}*${window.horizon} END`;
  const mean='(P1Amount+P2Amount+P3Amount)/3.0';
  const deviation=`(ABS(P1Amount-${mean})+ABS(P2Amount-${mean})+ABS(P3Amount-${mean}))/3.0`;
  const stability=`CASE WHEN ${historyRows}=0 THEN NULL WHEN ABS(${mean})=0 THEN 0 WHEN ${deviation}>=ABS(${mean}) THEN 0 ELSE 100.0*(1-${deviation}/ABS(${mean})) END`;
  const metrics=`${forecast('Amount')} ForecastAmount,${forecast('Qty')} ForecastQty,${forecast('Profit')} ForecastProfit,CASE WHEN ActualAmount=0 THEN NULL ELSE 100.0*((${forecast('Amount')})-ActualAmount*1.0/${window.days}*${window.horizon})/ABS(ActualAmount*1.0/${window.days}*${window.horizon}) END GrowthPercent,${stability} ConfidencePercent,ActualAmount,ActualQty,ActualProfit,${raw.filter(key=>!['ActualAmount','ActualQty','ActualProfit'].includes(key)).join(',')},${window.days} PeriodDays,${window.horizon} HorizonDays`;
  const all=`${base}, periods AS (SELECT ${aggregates} FROM sales)`;
  const grouped=`${base}, periods AS (SELECT GroupKey,MAX(GroupLabel) Label,${aggregates} FROM sales GROUP BY GroupKey)`;
  const check=`${base}, grouped AS (SELECT GroupKey,${aggregates} FROM sales GROUP BY GroupKey), periods AS (SELECT ${raw.map(key=>`COALESCE(SUM(${key}),0) ${key}`).join(',')} FROM grouped)`;
  const plan={title:report.name,detailLevel:'detailed',needsClarification:false,clarification:'',assumptions:[
    `Planning estimate, not guaranteed sales. Three previous equal-length periods (${window.historyStart} to ${iso(Date.parse(window.start)-day)}) supply the historical baseline.`,
    `Forecast = historical total / ${3*window.days} calendar days × ${window.horizon} forecast days. Zero-sale days stay in the denominator; no seasonality or price elasticity is assumed.`,
    `Planning horizon: ${window.futureStart} to ${window.futureEnd}. Monthly means a disclosed 30-day baseline. Growth compares the forecast with selected-period pace scaled to the same horizon.`,
    'ConfidencePercent is a history-stability score: 100 × max(0, 1 − mean absolute deviation / absolute mean) across the three period amounts. It is not a statistical probability or a backtested accuracy score; a zero baseline scores zero.',
    'Historical coverage must be complete. With no historical rows, forecast and confidence are unavailable (NULL), not zero. Growth is unavailable when the selected-period amount is zero. Verify resource coverage before purchasing.'
  ],queries:[{id:'totals',purpose:'Full-scope historical baseline and forecast',sql:`${all} SELECT ${metrics} FROM periods`},{id:'detail',purpose:'Forecast by requested business dimension',sql:`${grouped} SELECT ${live?'TOP (500) ':''}GroupKey,Label,${metrics} FROM periods ORDER BY ForecastAmount DESC,GroupKey${live?'':' LIMIT 500'}`},{id:'check',purpose:'Recompute forecast from all grouped historical totals',sql:`${check} SELECT ${metrics} FROM periods`}],visualization:{type:dimension?'bar':'none',queryId:'detail',labelKey:'Label',valueKey:'ForecastAmount'}};
  if(live)plan.executionBatch=`SET NOCOUNT ON; SET QUOTED_IDENTIFIER ON; ${base} SELECT * INTO #CherrySalesFacts FROM sales; `+plan.queries.map(query=>`WITH sales AS (SELECT * FROM #CherrySalesFacts)${query.sql.slice(base.length)};`).join('\n')+' DROP TABLE #CherrySalesFacts;';
  return plan;
}
module.exports={compileForecastReport,forecastWindow,supported};
