// The model selects a capability, never silently widens dates or branches.
const day = 86400000;
const iso = date => new Date(date).toISOString().slice(0, 10);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function resolveScope(question, context, previousCalls = []) {
  const q = question.toLowerCase();
  const followup = /\b(isi|same|ab|iska|is ka|uska|pichl[ae] jawab)\b/.test(q);
  const known = context.branches || [];
  const matched = known.filter(row => {
    const code = String(row.Branch), name = String(row.BranchName || '');
    return (name && q.includes(name.toLowerCase())) || new RegExp(`\\bbranch\\s+${escape(code)}\\b|\\b${escape(code)}\\s+branch\\b`, 'i').test(q);
  }).map(row => String(row.Branch));
  let rest = q;
  for (const row of known) {
    if (row.BranchName) rest = rest.replace(new RegExp(escape(row.BranchName), 'gi'), '');
    rest = rest.replace(new RegExp(`\\bbranch\\s+${escape(String(row.Branch))}\\b|\\b${escape(String(row.Branch))}\\s+branch\\b`, 'gi'), '');
  }
  rest = rest.replace(/\b(?:all|authorized|sab|sari|saray)\s+branches\b|\bbranch[- ]wise\b/g, '');
  if (/\bbranch\b/.test(rest)) return { clarification: 'Branch ka exact naam/code batayein; unknown branch ko all branches mein convert nahi karunga.' };
  let branches = matched;
  if (!branches.length && followup && previousCalls.length === 1 && !/\ball branches\b/.test(q)) branches = previousCalls[0].branches;
  const today = context.today, now = Date.parse(today), year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7));
  let periods = [];
  const pairs = [...q.matchAll(/(\d{4}-\d{2}-\d{2})\s*(?:to|se|through)\s*(\d{4}-\d{2}-\d{2})/g)];
  if (pairs.length) periods = pairs.map(match => ({ fromDate: match[1], toDate: match[2] }));
  const months = 'january|february|march|april|may|june|july|august|september|october|november|december';
  if (!periods.length) {
    const dates = [...q.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${months})\\s+(\\d{4})\\b`, 'g'))];
    if (dates.length === 2) {
      const values = dates.map(match => `${match[3]}-${String(months.split('|').indexOf(match[2]) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`);
      periods = [{ fromDate: values[0], toDate: values[1] }];
    } else if (dates.length) return { clarification: 'Start aur end date dono batayein.' };
  }
  if (!periods.length) {
    const named = [...q.matchAll(new RegExp(`\\b(${months})\\s+(\\d{4})\\b`, 'g'))];
    periods = named.map(match => {
      const m = months.split('|').indexOf(match[1]), y = Number(match[2]);
      return { fromDate: iso(Date.UTC(y, m, 1)), toDate: iso(Date.UTC(y, m + 1, 0)) };
    });
  }
  if (!periods.length) {
    if (/\b(today|aaj|aj)\b/.test(q)) periods.push({ fromDate: today, toDate: today });
    if (/\byesterday\b/.test(q)) periods.push({ fromDate: iso(now - day), toDate: iso(now - day) });
    if (/\bkal\b/.test(q)) return { clarification: 'Kal se yesterday murad hai ya tomorrow?' };
    if (/\b(this|current|is|iss) (month|mahina|mahine)\b/.test(q)) periods.push({ fromDate: `${today.slice(0, 7)}-01`, toDate: today });
    if (/\b(last|previous|pichla|pichle) (month|mahina|mahine)\b/.test(q)) periods.push({ fromDate: iso(Date.UTC(year, month - 2, 1)), toDate: iso(Date.UTC(year, month - 1, 0)) });
    const last = q.match(/\blast (\d{1,3}) (days|din)\b/);
    if (last && !periods.length && Number(last[1]) > 0) periods.push({ fromDate: iso(now - (Number(last[1]) - 1) * day), toDate: today });
  }
  if (!periods.length) {
    const single = [...q.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)];
    if (single.length === 1 && /as on|as of|balance sheet|cash.*position|aging/.test(q)) periods = [{fromDate:single[0][0],toDate:single[0][0]}];
  }
  if (!periods.length && followup && previousCalls.length === 1) periods = [{ fromDate: previousCalls[0].fromDate, toDate: previousCalls[0].toDate }];
  return { branches, periods };
}

function enforceScope(plan, question, context, previousCalls) {
  const scope = resolveScope(question, context, previousCalls);
  if (scope.clarification) return { clarification: scope.clarification, calls: [] };
  if (plan.clarification) return plan;
  const reportNames = [
    [/cash[ &-]*(?:and[ -]*)?bank position/i,'cash-bank-position'],
    [/cash[ -]*flow/i,'daily-cash-bank-flow'],
    [/balance[ -]*sheet/i,'balance-sheet'],
    [/trial[ -]*balance(?![ -]*(?:six|6))/i,'trial-balance'],
    [/trial[ -]*balance[ -]*(?:six|6)/i,'trial-balance-six-column'],
    [/receivable[ -]*aging/i,'receivable-aging'],
    [/payable[ -]*aging/i,'payable-aging'],
    [/chart of accounts/i,'chart-of-accounts'],
    [/accounting[ -]*ledger/i,'accounting-ledger'],
  ].filter(([pattern]) => pattern.test(question)).map(([,id])=>id);
  const calls = plan.calls.map(call => ({ ...call, ...(call.tool === 'accountingReport' && reportNames.length === 1 ? {reportId:reportNames[0]} : {}), branches: scope.branches }));
  const stock = calls.every(call => call.tool.startsWith('stock'));
  let periods = scope.periods;
  if (stock) {
    if (periods.length && !/\b(current|snapshot|abhi|maujooda)\b/.test(question.toLowerCase())) return { clarification: 'Stock tool current saved snapshot deta hai. Historical stock valuation is flow mein available nahi.', calls: [] };
    const saved = context.coverage?.find(row => row.Dataset === 'stock');
    periods = saved ? [{ fromDate: String(saved.FromDate).slice(0, 10), toDate: String(saved.ToDate).slice(0, 10) }] : [];
  } else if (!periods.length && /\bavailable (data|period)\b/i.test(question) && calls.every(call => call.tool.startsWith('sales'))) {
    const saved = context.coverage?.find(row => row.Dataset === 'sales');
    periods = saved ? [{ fromDate: String(saved.FromDate).slice(0, 10), toDate: String(saved.ToDate).slice(0, 10) }] : [];
  }
  if (!periods.length && calls.every(call => call.reportId === 'chart-of-accounts')) periods = [{fromDate:context.today,toDate:context.today}];
  if (!periods.length) return { clarification: 'Exact start/end dates ya month + year batayein. Date range guess nahi karunga.', calls: [] };
  if (periods.length !== 1 && periods.length !== calls.length) return { clarification: 'Comparison ke dono periods aur metric specify karein.', calls: [] };
  return { clarification: '', calls: calls.map((call, index) => ({ ...call, ...periods[periods.length === 1 ? 0 : index] })) };
}
module.exports = { resolveScope, enforceScope };
