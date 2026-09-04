const { sql, getPoolForTenant } = require("../config/db");
const aiConfig = require("../config/ai");
const {
  allowedTables,
  businessRules,
  tablePurposes,
  selectRelevantTables,
  trainingContextForTables,
} = require("../ai/knowledge");
const { validateReadOnlySql } = require("../ai/sqlSafety");
const { ollamaChat } = require("./ollamaService");
const reportService = require("./reportService");
const { getConversationTrainingPrompt } = require("../ai/conversationTraining");

function compactReport(report) {
  return {
    title: report.title,
    filters: report.filters,
    kpis: report.kpis,
    rows: (report.rows || []).slice(0, 12),
    note: report.note,
  };
}

function fallbackReportNarrative(report) {
  const facts = (report.kpis || []).map((kpi) => `${kpi.label}: ${Number(kpi.value || 0).toLocaleString("en-PK")}`);
  return {
    summary: facts.length ? facts.join(". ") : "Live data returned no measurable result for this scope.",
    keyPoints: facts.slice(0, 4),
    actions: report.rows?.length ? ["Review the strongest and weakest rows in the breakdown below."] : ["Widen the date or business filters if you expected activity."],
  };
}

async function generateReportNarrative(report, languageHint = "English") {
  try {
    const response = await ollamaChat([
      { role: "system", content: `You are Cherry AI, a careful POS management analyst. Use ONLY the supplied live figures. Never invent a number. Reply in ${languageHint}. Return JSON with summary (detailed but concise string), keyPoints (2-4 strings), and actions (1-3 practical strings). Money is PKR/Rs.` },
      { role: "user", content: JSON.stringify(compactReport(report)) },
    ], {
      json: true,
      temperature: 0.1,
      // A report must never fail behind a 30-second gateway merely because the
      // optional prose model is cold or busy. The deterministic fallback below
      // still explains the exact live KPIs when this budget is exceeded.
      timeoutMs: 12000,
      numCtx: 4096,
      numPredict: 256,
      think: false,
    });
    return {
      summary: String(response.summary || "").trim(),
      keyPoints: Array.isArray(response.keyPoints) ? response.keyPoints.map(String).slice(0, 4) : [],
      actions: Array.isArray(response.actions) ? response.actions.map(String).slice(0, 3) : [],
    };
  } catch (error) {
    return { ...fallbackReportNarrative(report), warning: `AI narrative unavailable: ${error.message}` };
  }
}

function detectRomanUrdu(text) {
  return /\b(bhai|batao|btao|kitna|kitni|kitne|aaj|aj|kal|parson|iss|is month|pichla|pichlay|branch wise|ka|ki|ke|ko|mera|meri|mujhe|maal|bikri|farokht|khareed|kharid|wapsi|wapas|konsi|kaunsi|sab se|zyada|kam|kyun|q|samjhao|dikhao)\b/i.test(text);
}

function resolveOutputLanguage(languageMode, question) {
  const selected = String(languageMode || "english-roman").trim().toLowerCase();
  if (selected === "urdu" || selected === "ur" || selected.includes("اردو")) return "urdu";
  return detectRomanUrdu(question) ? "roman" : "english";
}

function localizedText(language, values) {
  return values[language] || values.english || "";
}

function localizedKpiLabel(label, language) {
  if (language !== "urdu") return String(label || "");
  const text = String(label || "");
  const pairs = [
    [/^Net Sales$/i, "نیٹ سیلز"], [/^Net Quantity$/i, "نیٹ مقدار"], [/^Quantity$/i, "مقدار"],
    [/^Gross Profit$/i, "مجموعی منافع"], [/^Margin %$/i, "مارجن %"], [/^Discount$/i, "ڈسکاؤنٹ"],
    [/^Bills$/i, "بلز"], [/^Purchase Amount$/i, "خریداری کی رقم"], [/^Purchase Quantity$/i, "خریداری کی مقدار"],
    [/^Current Stock$/i, "موجودہ اسٹاک"], [/^Stock Value at Cost$/i, "لاگت پر اسٹاک ویلیو"],
    [/^Potential Retail Value$/i, "ممکنہ ریٹیل ویلیو"], [/^Total Paid$/i, "کل ادائیگی"],
    [/^Sent Quantity$/i, "بھیجی گئی مقدار"], [/^Received Quantity$/i, "موصول شدہ مقدار"],
    [/^In Transit$/i, "راستے میں مقدار"], [/^GST$/i, "جی ایس ٹی"], [/^Taxable Amount$/i, "قابلِ ٹیکس رقم"],
  ];
  for (const [pattern, translated] of pairs) if (pattern.test(text)) return translated;
  return text;
}

function resolveFollowUpQuestion(message, history = []) {
  const current = String(message || "").trim();
  const businessSubjectPattern = /\b(sale|sales|selling|revenue|bikri|farokht|purchase|purchasing|kharid|khareed|stock|inventory|maal|transfer|payment|cash|card|credit|discount|profit|margin|return|wapsi|bill|invoice|branch|outlet|store|godown|product|item|barcode|design|salesman|employee|supplier|customer|report)\b/i;
  const urduBusinessSubjectPattern = /(سیلز|فروخت|خریداری|اسٹاک|انوینٹری|ٹرانسفر|ادائیگی|کیش|کارڈ|کریڈٹ|ڈسکاؤنٹ|منافع|مارجن|واپسی|بل|انوائس|برانچ|شاخ|اسٹور|گودام|پروڈکٹ|آئٹم|بارکوڈ|ڈیزائن|سیلز مین|ملازم|سپلائر|رپورٹ)/i;
  const followUpPattern = /^(?:aur\s+)?(?:iski|iska|iske|iss ka|uski|uska|uske|aur|then|also|what about|forecast|prediction|predict|kal|yesterday|aaj|today|month|week|year|next|agle|agli|branch wise|store wise|product wise|salesman wise|top\s*\d*|bottom\s*\d*|best|worst|highest|lowest|graph|chart|detail|short|compare|growth|percent|kyun|q|why|reason|kitna|kitni|kitne)\b/i;
  const followUpContainsPattern = /\b(aur kal|aur aaj|same|isi ka|usi ka|next \d+ days|next week|next month|agle \d+ din|agli week|agla month|top \d+|bottom \d+|branch wise|store wise|product wise|salesman wise)\b/i;
  const urduFollowUpPattern = /^(اور|کل|آج|اگلے|اگلی|اگلا|برانچ وائز|اسٹور وائز|پروڈکٹ وائز|سیلز مین وائز|سب سے زیادہ|سب سے کم|کیوں|وجہ|موازنہ|تفصیل|پیش گوئی|اندازہ)/i;
  const historyItems = Array.isArray(history) ? history : [];
  const lastHistoryItem = historyItems[historyItems.length - 1];
  const lastAssistantAsked = lastHistoryItem?.role === "assistant"
    && (/\?|؟/.test(String(lastHistoryItem.content || "")) || /\b(which|what|please specify|kis|kaunsa|kitne)\b/i.test(String(lastHistoryItem.content || "")) || /(کون|کس|کتنے|واضح)/i.test(String(lastHistoryItem.content || "")));
  const compactReply = current.split(/\s+/).filter(Boolean).length <= 4;
  const isFollowUpLike = (value) => followUpPattern.test(String(value || "").trim())
    || followUpContainsPattern.test(String(value || ""))
    || urduFollowUpPattern.test(String(value || "").trim())
    || /^\d{3,18}$/.test(String(value || "").trim())
    || (lastAssistantAsked && compactReply);

  const hasBusinessSubject = businessSubjectPattern.test(current) || urduBusinessSubjectPattern.test(current);
  const looksLikeFollowUp = isFollowUpLike(current);
  if (hasBusinessSubject && !looksLikeFollowUp) return current;
  if (!looksLikeFollowUp) return current;

  const userHistory = (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === "user" && String(item.content || "").trim())
    .map((item) => String(item.content || "").trim());
  if (!userHistory.length) return current;

  const anchorSubjectPattern = /\b(sale|sales|selling|revenue|bikri|farokht|purchase|purchasing|kharid|khareed|stock|inventory|maal|transfer|payment|cash|card|credit|discount|profit|margin|return|wapsi|bill|invoice|report)\b/i;
  const urduAnchorPattern = /(سیلز|فروخت|خریداری|اسٹاک|انوینٹری|ٹرانسفر|ادائیگی|کیش|کارڈ|کریڈٹ|ڈسکاؤنٹ|منافع|مارجن|واپسی|بل|انوائس|رپورٹ)/i;
  let anchorIndex = -1;
  for (let index = userHistory.length - 1; index >= 0; index -= 1) {
    if (anchorSubjectPattern.test(userHistory[index]) || urduAnchorPattern.test(userHistory[index])) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) {
    for (let index = userHistory.length - 1; index >= 0; index -= 1) {
      if (businessSubjectPattern.test(userHistory[index]) || urduBusinessSubjectPattern.test(userHistory[index])) { anchorIndex = index; break; }
    }
  }
  if (anchorIndex < 0) anchorIndex = Math.max(0, userHistory.length - 1);

  const anchor = userHistory[anchorIndex];
  const recentContext = userHistory.slice(anchorIndex + 1).slice(-4);
  return [
    anchor,
    ...recentContext.map((text) => `Previous follow-up context: ${text}`),
    `Follow-up request: ${current}`,
  ].join("\n");
}

function inferFilters(message) {
  const text = String(message || "");
  // For a conversational follow-up we keep the previous business subject in
  // `text`, but the NEW follow-up must win for date/period words. Example:
  // "aaj ki sale" -> "aur kal?" must resolve to yesterday, not today just
  // because the previous question still contains the word "aaj".
  const followUpMatch = text.match(/Follow-up request:\s*([\s\S]*)$/i);
  const followUpText = followUpMatch?.[1]?.trim() || "";
  const previousFollowUpTexts = [...text.matchAll(/Previous follow-up context:\s*([^\n]+)/gi)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);
  const hasPeriodCue = (value) => /\b(aaj|aj|today|kal|yesterday|this|current|iss?|is|last|previous|pichl[aei]y?|week|month|mahina|maheena|year|saal|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|20\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]20\d{2})\b/i.test(String(value || "")) || /(آج|کل|اس ہفتے|پچھلے ہفتے|گزشتہ ہفتے|اس مہینے|پچھلے مہینے|گزشتہ ماہ|اس سال|پچھلے سال|گزشتہ سال)/i.test(String(value || ""));
  // New period wins. If the new turn only says "branch wise?", inherit the
  // most recent follow-up period; otherwise inherit the anchor question period.
  const inheritedPeriodText = [...previousFollowUpTexts].reverse().find(hasPeriodCue) || "";
  const periodText = hasPeriodCue(followUpText)
    ? followUpText
    : inheritedPeriodText || text;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const current = new Date(`${today}T00:00:00Z`);
  let fromDate = `${today.slice(0, 8)}01`;
  let toDate = today;

  const iso = (date) => date.toISOString().slice(0, 10);
  const setDaysAgo = (days) => {
    const start = new Date(current); start.setUTCDate(start.getUTCDate() - Math.max(0, days - 1));
    fromDate = iso(start); toDate = today;
  };

  if (/\b(aaj|aj|today)\b/i.test(periodText) || /آج/i.test(periodText)) fromDate = toDate = today;
  else if (/\b(yesterday|kal)\b/i.test(periodText) || /کل/i.test(periodText)) {
    const date = new Date(current); date.setUTCDate(date.getUTCDate() - 1);
    fromDate = toDate = iso(date);
  } else if (/\b(last|previous|pichl[aei]y?)\s+(7|seven)\s+days?\b|\blast\s+7\s+days?\b/i.test(periodText)) setDaysAgo(7);
  else if (/\b(last|previous|pichl[aei]y?)\s+(30|thirty)\s+days?\b|\blast\s+30\s+days?\b/i.test(periodText)) setDaysAgo(30);
  else if (/\b(this|current|iss?|is)\s+week\b/i.test(periodText)) {
    const day = current.getUTCDay() || 7;
    const first = new Date(current); first.setUTCDate(first.getUTCDate() - day + 1);
    fromDate = iso(first); toDate = today;
  } else if (/\b(last|previous|pichl[aei]y?)\s+week\b/i.test(periodText) || /(پچھلے|گزشتہ)\s*ہفتے/i.test(periodText)) {
    const day = current.getUTCDay() || 7;
    const thisMonday = new Date(current); thisMonday.setUTCDate(thisMonday.getUTCDate() - day + 1);
    const lastEnd = new Date(thisMonday); lastEnd.setUTCDate(lastEnd.getUTCDate() - 1);
    const lastStart = new Date(lastEnd); lastStart.setUTCDate(lastStart.getUTCDate() - 6);
    fromDate = iso(lastStart); toDate = iso(lastEnd);
  } else if (/\b(last month|previous month|pichla month|pichlay month|pichle month|pichla mahina|pichlay maheena)\b/i.test(periodText) || /(پچھلے مہینے|گزشتہ ماہ)/i.test(periodText)) {
    const first = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 0));
    fromDate = iso(first); toDate = iso(last);
  } else if (/\b(this|current|iss?|is)\s+(year|saal)\b/i.test(periodText) || /اس\s*سال/i.test(periodText)) {
    fromDate = `${current.getUTCFullYear()}-01-01`; toDate = today;
  } else if (/\b(last|previous|pichl[aei]y?)\s+(year|saal)\b/i.test(periodText) || /(پچھلے|گزشتہ)\s*سال/i.test(periodText)) {
    const year = current.getUTCFullYear() - 1;
    fromDate = `${year}-01-01`; toDate = `${year}-12-31`;
  }

  const monthNames = [
    ["jan(?:uary)?", 0], ["feb(?:ruary)?", 1], ["mar(?:ch)?", 2],
    ["apr(?:il)?", 3], ["may", 4], ["jun(?:e)?", 5],
    ["jul(?:y)?", 6], ["aug(?:ust)?", 7], ["sep(?:t(?:ember)?)?", 8],
    ["oct(?:ober)?", 9], ["nov(?:ember)?", 10], ["dec(?:ember)?", 11],
  ];
  for (const [pattern, monthIndex] of monthNames) {
    const match = periodText.match(new RegExp(`\\b${pattern}\\b(?:\\s+(20\\d{2}))?`, "i"));
    if (!match) continue;
    let year = match[1] ? Number(match[1]) : current.getUTCFullYear();
    if (!match[1] && Number(monthIndex) > current.getUTCMonth()) year -= 1;
    const first = new Date(Date.UTC(year, Number(monthIndex), 1));
    const last = new Date(Date.UTC(year, Number(monthIndex) + 1, 0));
    fromDate = iso(first); toDate = iso(last);
    break;
  }

  const explicitIso = [...periodText.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)].map((match) => match[0]);
  if (explicitIso.length) fromDate = explicitIso[0];
  if (explicitIso.length > 1) toDate = explicitIso[1];

  const explicitDmy = [...periodText.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/g)]
    .map((match) => `${match[3]}-${String(match[2]).padStart(2, "0")}-${String(match[1]).padStart(2, "0")}`);
  if (explicitDmy.length) fromDate = explicitDmy[0];
  if (explicitDmy.length > 1) toDate = explicitDmy[1];
  if (explicitDmy.length === 1 && !/\b(from|to|se|tak|between)\b/i.test(periodText)) toDate = explicitDmy[0];

  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  const barcode = text.match(/\b\d{6,18}\b/)?.[0];
  return { fromDate, toDate, ...(barcode ? { barcodes: [barcode] } : {}) };
}

function chooseFastReport(message) {
  const text = String(message || "").toLowerCase();

  // Predictive/diagnostic questions are handled by dedicated logic before this
  // function. Keep genuinely open-ended causal questions on the planner path.
  if (/\b(why|kyun|reason|cause|forecast|predict|prediction|explain anomaly|root cause)\b/i.test(text) || /(کیوں|وجہ|پیش گوئی|اندازہ)/i.test(text)) return null;

  if (/purchase return|supplier return|purchase waps|kharid.*waps|khareed.*waps/.test(text) || /(خریداری.*واپسی|سپلائر.*واپسی)/i.test(text)) return "RPT_05_009_PURCHASE_RETURN";
  if (/discount policy|discount applies|discount lage|active discount/.test(text) || /(ڈسکاؤنٹ.*پالیسی|فعال ڈسکاؤنٹ)/i.test(text)) return "RPT_16_016_DISCOUNT_POLICY_COMPLIANCE";
  if (/fbr|gst|taxable sales|tax summary/.test(text) || /(جی ایس ٹی|ٹیکس|ایف بی آر)/i.test(text)) return "RPT_26_001_FBR_SALES_SUMMARY";
  if (/payment|cash.*card|card.*credit|cash.*credit|tender/.test(text) || /(ادائیگی|کیش|کارڈ|کریڈٹ)/i.test(text)) return "RPT_02_032_CASH_CARD_CREDIT_SALES";
  if (/transfer|in transit|received|bheja|receive/.test(text) || /(ٹرانسفر|راستے میں|موصول|بھیجا)/i.test(text)) return "RPT_06_013_SENT_VS_RECEIVED_QUANTITY";
  if (/stock take|physical stock|physical count/.test(text) || /(فزیکل اسٹاک|اسٹاک ٹیک)/i.test(text)) return "RPT_03_001_CURRENT_STOCK";
  if (/stock adjustment|stock adj/.test(text) || /(اسٹاک ایڈجسٹمنٹ)/i.test(text)) return "RPT_03_002_BARCODE_STOCK_LEDGER";

  if (/\b(stock|inventory|on hand|available|availability|maal)\b/.test(text) || /(اسٹاک|انوینٹری|موجودہ مال)/i.test(text)) return "RPT_03_001_CURRENT_STOCK";

  if (/purchase|purchasing|kharid|khareed/.test(text) || /(خریداری|خریدا|خرید)/i.test(text)) {
    if (/supplier wise|party wise|vendor wise|supplier|vendor/.test(text) || /(سپلائر وائز|پارٹی وائز|سپلائر)/i.test(text)) return "RPT_05_003_SUPPLIER_WISE_PURCHASE";
    return "RPT_05_001_PURCHASE_REGISTER";
  }

  if (/sale|sales|selling|farokht|bikri|revenue|profit|margin/.test(text) || /(سیلز|فروخت|ریونیو|منافع|مارجن)/i.test(text)) {
    if (/branch wise|outlet wise|shop wise|which branch|kis branch|konsi branch|kaunsi branch|best branch|worst branch|top.*branch|bottom.*branch/.test(text) || /(برانچ وائز|شاخ وائز|کس برانچ|سب سے زیادہ.*برانچ|سب سے کم.*برانچ)/i.test(text)) return "RPT_02_005_BRANCH_WISE_SALES";
    if (/store wise|stockroom wise|godown wise|which store|best store|worst store|top.*store|bottom.*store/.test(text) || /(اسٹور وائز|گودام وائز)/i.test(text)) return "RPT_02_006_STORE_WISE_SALES";
    if (/brand wise|which brand|best brand|worst brand|top.*brand|bottom.*brand/.test(text) || /(برانڈ وائز|کس برانڈ)/i.test(text)) return "RPT_02_010_BRAND_WISE_SALES";
    if (/category wise|catagory wise|which category|which catagory|best category|worst category|top.*categor|bottom.*categor/.test(text) || /(کیٹیگری وائز|کس کیٹیگری)/i.test(text)) return "RPT_02_012_CATEGORY_WISE_SALES";
    if (/barcode wise|product wise|item wise|design wise|which product|which item|top\s*\d*\s*(selling\s*)?(product|item|design|barcode)s?|bottom\s*\d*\s*(product|item|design|barcode)s?|best selling|slow selling/.test(text) || /(بارکوڈ وائز|پروڈکٹ وائز|آئٹم وائز|ڈیزائن وائز|سب سے زیادہ.*پروڈکٹ|سب سے کم.*پروڈکٹ)/i.test(text)) return "RPT_02_008_BARCODE_WISE_SALES";
    if (/daily|day wise|rozana|trend|day by day/.test(text) || /(روزانہ|دن وائز|ٹرینڈ)/i.test(text)) return "RPT_02_002_DAILY_SALES";
    if (/\b(top|bottom)\s*\d*\b/.test(text) || /(سب سے زیادہ|سب سے کم)/i.test(text)) return "RPT_02_008_BARCODE_WISE_SALES";
    return "RPT_02_001_SALES_SUMMARY";
  }
  return null;
}

function shouldShowAssistantVisualization(question, chart) {
  const requested = /\b(graph|chart|graphical|visual|trend|compare|comparison|versus|vs|growth|grow|percent|percentage|branch[- ]?wise|store[- ]?wise|day[- ]?wise|daily|month[- ]?wise|monthly|ranking|breakdown|distribution|mix)\b/i.test(String(question || ""));
  const data = Array.isArray(chart?.data) ? chart.data : [];
  const meaningful = data.length > 1 && data.some((row) =>
    Math.abs(Number(row?.Amount ?? row?.Quantity ?? row?.value ?? 0)) > 0,
  );
  return requested && meaningful;
}


function formatKpiValue(kpi) {
  const value = Number(kpi?.value || 0);
  if (kpi?.format === "currency") return `Rs ${value.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (kpi?.format === "percent") return `${value.toLocaleString("en-PK", { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString("en-PK", { maximumFractionDigits: 2 });
}

function friendlyPeriod(filters = {}, language = "english") {
  const from = String(filters.fromDate || "");
  const to = String(filters.toDate || "");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const todayDate = new Date(`${today}T00:00:00Z`);
  const yesterdayDate = new Date(todayDate); yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  if (from === today && to === today) return localizedText(language, { english: "Today", roman: "Aaj", urdu: "آج" });
  if (from === yesterday && to === yesterday) return localizedText(language, { english: "Yesterday", roman: "Kal", urdu: "کل" });
  if (from && from === to) return from;
  if (from && to) return language === "urdu" ? `${from} سے ${to}` : `${from} to ${to}`;
  return localizedText(language, { english: "Selected period", roman: "Selected period", urdu: "منتخب مدت" });
}

function requestedRank(question) {
  const text = String(question || "");
  const match = text.match(/\b(top|bottom)\s*(\d{1,2})?\b/i);
  if (match) return { direction: match[1].toLowerCase(), count: Math.max(1, Math.min(Number(match[2] || 5), 20)) };
  if (/سب سے زیادہ/i.test(text)) return { direction: "top", count: 5 };
  if (/سب سے کم/i.test(text)) return { direction: "bottom", count: 5 };
  return null;
}

function analysisThinkLevelForQuestion(question) {
  const text = String(question || "").toLowerCase();
  const hardest = /\b(deep|detailed|why|reason|root cause|forecast|prediction|predict|strategy|strategic|risk|anomaly|trend|management|recommend|suggest|compare|comparison|growth|decline|improve|optimization|optimise|optimize|kyun|wajah|tafseel|analysis|analyze)\b/i.test(text)
    || /(کیوں|وجہ|تجزیہ|پیش گوئی|اندازہ|حکمت عملی|خطرہ|موازنہ|بہتری)/i.test(String(question || ""));
  if (hardest) return aiConfig.ollamaMaxThinking ? "max" : aiConfig.ollamaComplexThinkLevel;
  return aiConfig.ollamaPlannerThinkLevel;
}

function wantsComparison(question) {
  return /\b(compare|comparison|versus|\bvs\b|growth|grow|change|difference|kal se|previous period|pichl[aei].*muqabla)\b/i.test(String(question || ""))
    || /(موازنہ|مقابلہ|فرق|اضافہ|کمی)/i.test(String(question || ""));
}

function previousComparableFilters(filters) {
  const start = new Date(`${filters.fromDate}T00:00:00Z`);
  const end = new Date(`${filters.toDate}T00:00:00Z`);
  const days = Math.max(1, Math.round((end - start) / 86400000) + 1);
  const previousEnd = new Date(start); previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd); previousStart.setUTCDate(previousStart.getUTCDate() - days + 1);
  return {
    ...filters,
    fromDate: previousStart.toISOString().slice(0, 10),
    toDate: previousEnd.toISOString().slice(0, 10),
  };
}

function isQuantityQuestion(question) {
  const text = String(question || "");
  return /\b(qty|quantity|quantities|piece|pieces|pcs|unit|units|kitne\s*(?:piece|pcs|unit)|kitni\s*quantity)\b/i.test(text)
    || /(مقدار|تعداد|پیِس|پیس|یونٹ)/i.test(text);
}

function isAmountQuestion(question) {
  const text = String(question || "");
  return /\b(amount|value|revenue|net sales?|sales? amount|rupees?|rs\.?|pkr|kitni sale|kitna sale|kitni bikri|kitna revenue)\b/i.test(text)
    || /(رقم|مالیت|نیٹ\s*سیلز|سیلز\s*رقم|کتنی\s*فروخت|کتنی\s*سیل)/i.test(text);
}

function requestedKpis(report, question) {
  const q = String(question || "");
  const kpis = Array.isArray(report?.kpis) ? report.kpis.filter((kpi) => kpi && kpi.label) : [];
  const selected = [];
  const add = (regex) => {
    for (const kpi of kpis) if (regex.test(String(kpi.label || "")) && !selected.includes(kpi)) selected.push(kpi);
  };
  const quantity = isQuantityQuestion(q);
  const explicitAmount = isAmountQuestion(q);

  if (/\b(bill|bills|invoice count|transactions? count|kitne bill|بل)\b/i.test(q)) add(/bill|invoice/i);
  if (/\b(discount|disc|ڈسکاؤنٹ)\b/i.test(q)) add(/discount/i);
  if (/\b(gross profit|profit|kamai|منافع)\b/i.test(q)) add(/profit/i);
  if (/\b(margin|مارجن)\b/i.test(q)) add(/margin/i);
  if (/\b(gst|tax|ٹیکس|جی ایس ٹی)\b/i.test(q)) add(/gst|tax/i);
  if (/\b(stock value|inventory value|cost value|retail value|اسٹاک.*ویلیو)\b/i.test(q)) add(/value|cost/i);
  if (/\b(sent|bhej|بھیج)\b/i.test(q)) add(/sent/i);
  if (/\b(received|receive|mila|موصول)\b/i.test(q)) add(/received/i);
  if (/\b(in transit|pending transfer|راستے|زیرِ ترسیل)\b/i.test(q)) add(/transit|pending/i);
  if (quantity) add(/quantity|qty|current stock/i);

  // Explicit quantity questions should not drag sales amount into every reply.
  // Amount is added only when asked, or as the natural default for a sales/
  // purchase/payment question that did not request another metric.
  const hasSpecificNonAmount = selected.length > 0;
  const asksBothSaleAndQty = quantity && /\b(sale|sales|revenue|bikri|farokht|purchase|kharid|khareed)\b/i.test(q)
    && /\b(and|aur|ساتھ|اور)\b/i.test(q);
  if (explicitAmount || asksBothSaleAndQty) {
    add(/net sales|purchase amount|amount|total paid|sales/i);
  } else if (!hasSpecificNonAmount) {
    const primaryCurrency = kpis.find((kpi) => kpi.format === "currency");
    if (primaryCurrency) selected.push(primaryCurrency);
    else if (kpis[0]) selected.push(kpis[0]);
  }
  return selected;
}

function primaryMetric(report, question = "") {
  return requestedKpis(report, question)[0]
    || (report?.kpis || []).find((kpi) => kpi?.format === "currency" && Number.isFinite(Number(kpi?.value)))
    || (report?.kpis || []).find((kpi) => Number.isFinite(Number(kpi?.value)))
    || null;
}

function formatNumberValue(value, format = "number") {
  const numeric = Number(value || 0);
  if (format === "currency") return `Rs ${numeric.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (format === "percent") return `${numeric.toLocaleString("en-PK", { maximumFractionDigits: 2 })}%`;
  return numeric.toLocaleString("en-PK", { maximumFractionDigits: 2 });
}

function comparisonNarrative(currentReport, previousReport, question, language = "english") {
  const requested = requestedKpis(currentReport, question);
  const currentMetrics = requested.length ? requested : [primaryMetric(currentReport, question)].filter(Boolean);
  const currentPeriod = friendlyPeriod(currentReport.filters, language);
  const previousPeriod = friendlyPeriod(previousReport.filters, language);
  const lines = currentMetrics.map((current) => {
    const previous = (previousReport?.kpis || []).find((kpi) => kpi?.key === current?.key)
      || (previousReport?.kpis || []).find((kpi) => String(kpi?.label || "") === String(current?.label || ""))
      || primaryMetric(previousReport, question);
    const currentValue = Number(current?.value || 0);
    const previousValue = Number(previous?.value || 0);
    const change = currentValue - previousValue;
    const pct = previousValue === 0 ? null : (change * 100) / Math.abs(previousValue);
    const label = localizedKpiLabel(current?.label || previous?.label || "Value", language);
    const format = current?.format || previous?.format || "number";
    const direction = change > 0
      ? localizedText(language, { english: "increase", roman: "increase", urdu: "اضافہ" })
      : change < 0
        ? localizedText(language, { english: "decrease", roman: "decrease", urdu: "کمی" })
        : localizedText(language, { english: "no change", roman: "koi change nahi", urdu: "کوئی تبدیلی نہیں" });
    const pctText = pct == null ? "" : ` (${Math.abs(pct).toLocaleString("en-PK", { maximumFractionDigits: 2 })}%)`;
    const difference = formatNumberValue(Math.abs(change), format);
    if (language === "urdu") {
      return `${label}: ${currentPeriod} ${formatNumberValue(currentValue, format)}، ${previousPeriod} ${formatNumberValue(previousValue, format)}؛ ${difference} کا ${direction}${pctText}۔`;
    }
    if (language === "roman") {
      return `${label}: ${currentPeriod} ${formatNumberValue(currentValue, format)}, ${previousPeriod} ${formatNumberValue(previousValue, format)}; ${difference} ka ${direction}${pctText}.`;
    }
    return `${label}: ${currentPeriod} ${formatNumberValue(currentValue, format)} vs ${formatNumberValue(previousValue, format)} in ${previousPeriod}; ${direction} ${difference}${pctText}.`;
  });
  return { summary: lines.join("\n"), keyPoints: [], actions: [] };
}

function requestedRowMetrics(question, row) {
  const q = String(question || "");
  const metrics = [];
  const add = (key, label, format = "number") => {
    if (row?.[key] != null && !metrics.some((item) => item.key === key)) metrics.push({ key, label, format });
  };
  const quantity = isQuantityQuestion(q);
  if (/\b(profit|kamai|منافع)\b/i.test(q)) add("GrossProfit", "Gross Profit", "currency");
  if (/\b(margin|مارجن)\b/i.test(q)) add("MarginPercent", "Margin %", "percent");
  if (/\b(sent|bhej|بھیج)\b/i.test(q)) add("SentQuantity", "Sent Quantity");
  if (/\b(received|receive|موصول)\b/i.test(q)) add("ReceivedQuantity", "Received Quantity");
  if (/\b(in transit|pending|راستے)\b/i.test(q)) add("PendingQuantity", "In Transit");
  if (quantity) add("Quantity", "Quantity");
  if (isAmountQuestion(q) || (!metrics.length && !quantity)) add("Amount", "Amount", "currency");
  if (!metrics.length && row?.Quantity != null) add("Quantity", "Quantity");
  return metrics;
}

function wantsBreakdown(question) {
  return /\b(branch wise|outlet wise|shop wise|store wise|godown wise|product wise|item wise|barcode wise|design wise|brand wise|category wise|catagory wise|salesman wise|day wise|daily|ranking|breakdown|top|bottom|best|worst|highest|lowest)\b/i.test(String(question || ""))
    || /(برانچ وائز|اسٹور وائز|گودام وائز|پروڈکٹ وائز|آئٹم وائز|بارکوڈ وائز|ڈیزائن وائز|برانڈ وائز|کیٹیگری وائز|سیلز مین وائز|روزانہ|تفصیل|سب سے زیادہ|سب سے کم)/i.test(String(question || ""));
}

function naturalFastNarrative(report, question, language = "english") {
  const period = friendlyPeriod(report.filters, language);
  const rows = Array.isArray(report.rows) ? report.rows : [];
  const rank = requestedRank(question);

  // Payment questions such as "cash kitna aya?" are row-specific; do not answer
  // them with Total Paid unless the user actually asked for the total mix.
  if (/payment mix/i.test(String(report.title || "")) && rows.length) {
    const wanted = [];
    if (/\bcash\b/i.test(question) || /کیش/i.test(question)) wanted.push("Cash");
    if (/\bcard\b/i.test(question) || /کارڈ/i.test(question)) wanted.push("Card");
    if (/\bcredit\b/i.test(question) || /کریڈٹ/i.test(question)) wanted.push("Credit");
    const selected = wanted.length ? rows.filter((row) => wanted.includes(String(row.Label))) : rows;
    if (wanted.length || /\b(cash.*card|card.*credit|payment mix|tender|breakdown)\b/i.test(question) || /(ادائیگی|کیش.*کارڈ|کارڈ.*کریڈٹ)/i.test(question)) {
      const list = selected.map((row) => `${row.Label}: ${formatNumberValue(row.Amount, "currency")}`).join(" | ");
      const summary = language === "urdu" ? `${period} ادائیگی: ${list}۔` : language === "roman" ? `${period} payment: ${list}.` : `${period} payment: ${list}.`;
      return { summary, keyPoints: [], actions: [] };
    }
  }

  const shouldList = (rank || wantsBreakdown(question)) && rows.some((row) => row?.Label != null);
  if (shouldList && rows.length) {
    const metricSample = requestedRowMetrics(question, rows[0]);
    const sortMetric = metricSample[0]?.key || (rows[0]?.Amount != null ? "Amount" : rows[0]?.Quantity != null ? "Quantity" : null);
    let ordered = [...rows];
    if (sortMetric) ordered.sort((a, b) => Number(b?.[sortMetric] || 0) - Number(a?.[sortMetric] || 0));
    if (rank?.direction === "bottom") ordered.reverse();
    const limit = rank?.count || Math.min(10, ordered.length);
    const selected = ordered.slice(0, limit);
    const list = selected.map((row, index) => {
      const metrics = requestedRowMetrics(question, row);
      const values = metrics.map((metric) => `${localizedKpiLabel(metric.label, language)} ${formatNumberValue(row?.[metric.key], metric.format)}`);
      return `${index + 1}) ${String(row.Label ?? "Unassigned")}${values.length ? ` — ${values.join(" | ")}` : ""}`;
    });
    const heading = rank
      ? localizedText(language, { english: `${rank.direction === "bottom" ? "Bottom" : "Top"} ${selected.length}`, roman: `${rank.direction === "bottom" ? "Bottom" : "Top"} ${selected.length}`, urdu: `${rank.direction === "bottom" ? "سب سے کم" : "سب سے زیادہ"} ${selected.length}` })
      : localizedText(language, { english: "breakdown", roman: "breakdown", urdu: "تفصیل" });
    const summary = language === "urdu"
      ? `${period} ${heading}:\n${list.join("\n")}`
      : `${period} ${heading}:\n${list.join("\n")}`;
    return { summary, keyPoints: [], actions: [] };
  }

  const selectedKpis = requestedKpis(report, question);
  const factText = selectedKpis.map((kpi) => `${localizedKpiLabel(kpi.label, language)}: ${formatKpiValue(kpi)}`);
  if (!factText.length) {
    return { summary: localizedText(language, { english: `${period}: matching live result found.`, roman: `${period}: matching live result mil gaya.`, urdu: `${period}: متعلقہ لائیو نتیجہ مل گیا۔` }), keyPoints: [], actions: [] };
  }
  const summary = language === "urdu"
    ? `${period} — ${factText.join(" | ")}۔`
    : language === "roman"
      ? `${period} — ${factText.join(" | ")}.`
      : `${period} — ${factText.join(" | ")}.`;
  return { summary, keyPoints: [], actions: [] };
}

function assistantAnswerFromReport(report, narrative, question) {
  const chart = report.charts?.[0] || null;
  return {
    mode: "report",
    answer: narrative.summary,
    keyPoints: narrative.keyPoints || [],
    actions: narrative.actions || [],
    report,
    visualization: shouldShowAssistantVisualization(question, chart) ? chart : null,
    warning: narrative.warning || null,
  };
}


function businessAnalysisIntent(question) {
  const text = String(question || "");
  if (forecastIntent(text)) return false;
  return /\b(analy(?:s|z)e|analysis|why|kyun|reason|cause|root cause|trend|strategy|strategic|risk|anomaly|growth|decline|improve|optimization|optimise|optimize|recommend|suggest|performance review|management action)\b/i.test(text)
    || /(تجزیہ|کیوں|وجہ|حکمت عملی|خطرہ|رجحان|اضافہ|کمی|بہتری|مشورہ)/i.test(text);
}

function analysisRoutingQuestion(question) {
  return String(question || "")
    .replace(/\b(analy(?:s|z)e|analysis|why|kyun|reason|cause|root cause|deep|detailed|detail|explain|samjhao|tafseel|strategy|strategic|risk|anomaly|recommend|suggest|management action)\b/gi, " ")
    .replace(/(تجزیہ|کیوں|وجہ|تفصیل|سمجھائیں|حکمت عملی|خطرہ|مشورہ)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseVerifiedAnalysisReport(question) {
  if (!businessAnalysisIntent(question)) return null;
  const routed = analysisRoutingQuestion(question);
  return chooseFastReport(routed || question);
}

function compactAssistantAnalysisReport(report) {
  if (!report) return null;
  return {
    title: report.title,
    filters: report.filters,
    kpis: (report.kpis || []).slice(0, 12).map((kpi) => ({ label: kpi.label, value: Number(kpi.value || 0), format: kpi.format })),
    rows: (report.rows || []).slice(0, 20),
    note: report.note || "",
  };
}

async function generateAssistantBusinessAnalysis({ currentReport, previousReport, question, language }) {
  const fallback = previousReport
    ? comparisonNarrative(currentReport, previousReport, question, language)
    : naturalFastNarrative(currentReport, question, language);
  const responseLanguage = language === "urdu" ? "Urdu script" : language === "roman" ? "clear Roman Urdu" : "clear business English";

  try {
    const answer = await ollamaChat([
      {
        role: "system",
        content: `You are Cherry AI, a senior retail POS analyst. Reply in ${responseLanguage}. Use ONLY the supplied verified live figures; never invent a number or a cause. Answer the exact question asked. For why/diagnostic questions, distinguish a data-supported observation from a possible cause. If the supplied data cannot prove the cause, say so and state what extra breakdown would verify it. Keep the answer practical and management-oriented, normally 3-7 concise sentences. Do not expose SQL or hidden reasoning.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          question,
          current: compactAssistantAnalysisReport(currentReport),
          previousComparable: compactAssistantAnalysisReport(previousReport),
        }),
      },
    ], {
      temperature: 0.15,
      // Keep this below common gateway limits. If Cloud reasoning is cold/busy,
      // the deterministic verified-data fallback below is returned instead of
      // failing the Assistant request.
      timeoutMs: Math.min(aiConfig.ollamaTimeoutMs, aiConfig.ollamaAnalysisTimeoutMs || 48000),
      numCtx: 12288,
      numPredict: 900,
      think: true,
    });
    return { summary: answer, keyPoints: [], actions: [], warning: null };
  } catch (error) {
    return {
      ...fallback,
      warning: `Deep AI analysis was unavailable, so a verified live-data analysis was returned instead: ${error.message}`,
    };
  }
}

function forecastIntent(question) {
  const text = String(question || "").toLowerCase();
  const forward = /\b(forecast|predict|prediction|projection|future|expected|estimate|estimated|andaza|andaaza|umeed|aglay|agle|next)\b/i.test(text)
    || /(پیش گوئی|اندازہ|آئندہ)/i.test(text);
  const stockout = /\b(stock ?out|out of stock|khatam|finish|run out|days of stock|stock cover)\b/i.test(text)
    || /(کب ختم|اسٹاک.*ختم)/i.test(text);
  const reorder = /\b(reorder|order qty|purchase qty|kitna mangwa|kitni purchase|stock requirement|safety stock)\b/i.test(text)
    || /(دوبارہ آرڈر|کتنا منگو)/i.test(text);
  if (stockout) return "stockout";
  if (reorder) return "reorder";
  if (!forward) return null;
  if (/\b(demand|qty|quantity|pieces|units)\b/i.test(text) || /(طلب|مقدار)/i.test(text)) return "demand";
  if (/\b(stock|inventory)\b/i.test(text) || /اسٹاک/i.test(text)) return "stock";
  return "sales";
}

function forecastWindow(question) {
  const text = String(question || "").toLowerCase();
  const todayText = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const today = new Date(`${todayText}T00:00:00Z`);
  const tomorrow = new Date(today); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const iso = (date) => date.toISOString().slice(0, 10);
  let start = new Date(tomorrow);
  let end = null;
  let days = null;

  if (/\b(tomorrow|kal)\b/i.test(text)) days = 1;
  const nMatch = text.match(/\b(?:next|agle|aglay|agli)?\s*(7|15|30|60|90)\s*(?:days?|din)\b/i) || text.match(/(?:اگلے|آئندہ)?\s*(7|15|30|60|90)\s*دن/i);
  if (nMatch) days = Number(nMatch[1]);
  if (/\b(next|agli|aglay)\s+week\b/i.test(text) || /(اگلے|اگلا)\s*ہفت/i.test(text)) days = 7;
  if (/\b(next|agla|agli)\s+month\b/i.test(text) || /(اگلے|اگلا)\s*مہین/i.test(text)) {
    start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 0));
    days = Math.round((end - start) / 86400000) + 1;
  } else if ((/\b(this|current|iss?|is)\s+month\b/i.test(text) || /(اس|موجودہ)\s*مہین/i.test(text)) && /\b(forecast|predict|prediction|future|andaza|andaaza|پیش گوئی|اندازہ)\b/i.test(text)) {
    end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
    if (start > end) start = new Date(today);
    days = Math.max(1, Math.round((end - start) / 86400000) + 1);
  }
  if (!days) return null;
  if (!end) { end = new Date(start); end.setUTCDate(end.getUTCDate() + days - 1); }
  return { fromDate: iso(start), toDate: iso(end), days };
}

function clarificationForQuestion(originalQuestion, resolvedQuestion, history, filters, language) {
  const q = String(originalQuestion || "").trim();
  const combined = String(resolvedQuestion || q);
  const hasHistory = Array.isArray(history) && history.some((item) => item?.role === "user" && String(item.content || "").trim());
  const intent = forecastIntent(combined);
  const subject = /\b(sale|sales|revenue|bikri|farokht|purchase|kharid|khareed|stock|inventory|demand|payment|profit|margin|return|transfer|branch|product|barcode|design|salesman)\b/i.test(combined)
    || /(سیلز|فروخت|خریداری|اسٹاک|طلب|ادائیگی|منافع|واپسی|ٹرانسفر|برانچ|پروڈکٹ|بارکوڈ|ڈیزائن)/i.test(combined);

  const asksStockValue = /\b(stock|inventory)\b.*\b(value|valuation|worth)\b|\b(value|valuation|worth)\b.*\b(stock|inventory)\b/i.test(combined)
    || /(اسٹاک|انوینٹری).*(ویلیو|قدر|مالیت)|(ویلیو|قدر|مالیت).*(اسٹاک|انوینٹری)/i.test(combined);
  const specifiesStockValueBasis = /\b(cost|purchase|retail|sale price|selling price|mrp)\b/i.test(combined)
    || /(لاگت|خرید|ریٹیل|فروختی قیمت|سیل پرائس)/i.test(combined);

  if (asksStockValue && !specifiesStockValueBasis) {
    return {
      answer: localizedText(language, {
        english: "Should I calculate stock value at cost/purchase value or at retail/selling value?",
        roman: "Stock value cost/purchase value par chahiye ya retail/selling value par?",
        urdu: "اسٹاک ویلیو لاگت/خریداری قیمت پر چاہیے یا ریٹیل/فروختی قیمت پر؟",
      }),
      options: language === "urdu"
        ? ["اسٹاک ویلیو لاگت پر", "اسٹاک ویلیو ریٹیل قیمت پر"]
        : ["Stock value at cost", "Stock value at retail"],
    };
  }

  if (/^(why|kyun|q|reason|kya hua|کیوں)[?.! ]*$/i.test(q) && !hasHistory) {
    return {
      answer: localizedText(language, {
        english: "Which result should I investigate, and for which period?",
        roman: "Kis result ka reason check karun, aur kis period ka?",
        urdu: "میں کس نتیجے کی وجہ چیک کروں، اور کس مدت کے لیے؟",
      }),
      options: [],
    };
  }
  if (/^(best|worst|top|bottom|highest|lowest|سب سے زیادہ|سب سے کم)[?.! ]*$/i.test(q) && !hasHistory) {
    return {
      answer: localizedText(language, {
        english: "Best/worst by what metric — sales amount, quantity, profit, or stock?",
        roman: "Best/worst kis metric par chahiye — sales amount, quantity, profit ya stock?",
        urdu: "بہترین/کم ترین کس میٹرک پر چاہیے — سیلز رقم، مقدار، منافع یا اسٹاک؟",
      }),
      options: language === "urdu"
        ? ["اس مہینے سیلز رقم کے لحاظ سے ٹاپ برانچز", "اس مہینے مقدار کے لحاظ سے ٹاپ پروڈکٹس", "اس مہینے منافع کے لحاظ سے ٹاپ برانچز"]
        : ["Top branches by sales amount this month", "Top products by quantity this month", "Top branches by profit this month"],
    };
  }
  if (intent && !subject && !hasHistory) {
    return {
      answer: localizedText(language, {
        english: "What should I predict — sales amount, demand quantity, stockout, or reorder requirement?",
        roman: "Kis cheez ki prediction chahiye — sales amount, demand quantity, stockout ya reorder requirement?",
        urdu: "کس چیز کی پیش گوئی چاہیے — سیلز رقم، طلب کی مقدار، اسٹاک ختم ہونے کا وقت یا ری آرڈر ضرورت؟",
      }),
      options: language === "urdu"
        ? ["اگلے 7 دن کی سیلز پیش گوئی", "اگلے 30 دن کی طلب پیش گوئی", "بارکوڈ اسٹاک آؤٹ پیش گوئی"]
        : ["Next 7 days sales forecast", "Next 30 days demand forecast", "Barcode stockout prediction"],
    };
  }
  if ((intent === "sales" || intent === "demand") && !forecastWindow(combined)) {
    const subjectText = intent === "demand" ? "demand" : "sales";
    return {
      answer: localizedText(language, {
        english: `What forecast horizon do you want for ${subjectText}?`,
        roman: `${subjectText === "sales" ? "Sales" : "Demand"} forecast kis period ki chahiye?`,
        urdu: `${subjectText === "sales" ? "سیلز" : "طلب"} کی پیش گوئی کس مدت کے لیے چاہیے؟`,
      }),
      options: language === "urdu"
        ? [`اگلے 7 دن کی ${subjectText === "sales" ? "سیلز" : "طلب"} پیش گوئی`, `اگلے 30 دن کی ${subjectText === "sales" ? "سیلز" : "طلب"} پیش گوئی`, `اگلے مہینے کی ${subjectText === "sales" ? "سیلز" : "طلب"} پیش گوئی`]
        : [`Next 7 days ${subjectText} forecast`, `Next 30 days ${subjectText} forecast`, `Next month ${subjectText} forecast`],
    };
  }
  if (intent === "stock" && !forecastWindow(combined)) {
    return {
      answer: localizedText(language, {
        english: "What future period should I use for the stock forecast?",
        roman: "Stock forecast kis future period ki chahiye?",
        urdu: "اسٹاک کی پیش گوئی کس آئندہ مدت کے لیے چاہیے؟",
      }),
      options: language === "urdu"
        ? ["اگلے 7 دن کی اسٹاک پیش گوئی", "اگلے 30 دن کی اسٹاک پیش گوئی", "اگلے مہینے کی اسٹاک پیش گوئی"]
        : ["Next 7 days stock forecast", "Next 30 days stock forecast", "Next month stock forecast"],
    };
  }
  if ((intent === "stockout" || intent === "reorder" || intent === "stock") && !(filters?.barcodes || []).length) {
    return {
      answer: localizedText(language, {
        english: "Which barcode/design should I use for this stock prediction? Send the barcode so I can calculate it precisely.",
        roman: "Is stock prediction ke liye kaunsa barcode/design use karun? Barcode bhej dein taake exact calculation kar sakun.",
        urdu: "اس اسٹاک پیش گوئی کے لیے کون سا بارکوڈ/ڈیزائن استعمال کروں؟ درست حساب کے لیے بارکوڈ بھیج دیں۔",
      }),
      options: [],
    };
  }
  if (intent === "reorder" && !forecastWindow(combined)) {
    return {
      answer: localizedText(language, {
        english: "For how much future cover should I calculate the reorder quantity?",
        roman: "Reorder quantity kitne future days ke cover ke liye calculate karun?",
        urdu: "ری آرڈر مقدار کتنے آئندہ دنوں کے اسٹاک کور کے لیے حساب کروں؟",
      }),
      options: language === "urdu"
        ? ["اگلے 7 دن کے لیے ری آرڈر", "اگلے 30 دن کے لیے ری آرڈر", "اگلے 90 دن کے لیے ری آرڈر"]
        : ["Reorder for next 7 days", "Reorder for next 30 days", "Reorder for next 90 days"],
    };
  }
  return null;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function average(values) { return values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : 0; }
function standardDeviation(values) {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (Number(value || 0) - mean) ** 2)));
}
function weightedAverage(values) {
  if (!values.length) return 0;
  let weighted = 0; let weightTotal = 0;
  values.forEach((value, index) => { const weight = index + 1; weighted += Number(value || 0) * weight; weightTotal += weight; });
  return weightTotal ? weighted / weightTotal : 0;
}

async function buildSalesForecast({ pool, user, filters, question, language, intent, window }) {
  if (!window?.fromDate || !window?.toDate) {
    return {
      mode: "clarify",
      answer: localizedText(language, {
        english: "What future period should I forecast — next 7 days, next 30 days, or next month?",
        roman: "Forecast kis future period ki chahiye — next 7 days, next 30 days ya next month?",
        urdu: "پیش گوئی کس آئندہ مدت کی چاہیے — اگلے 7 دن، اگلے 30 دن یا اگلا مہینہ؟",
      }),
      keyPoints: [], actions: [], rows: [], visualization: null,
      followUpOptions: language === "urdu" ? ["اگلے 7 دن کی پیش گوئی", "اگلے 30 دن کی پیش گوئی", "اگلے مہینے کی پیش گوئی"] : ["Next 7 days forecast", "Next 30 days forecast", "Next month forecast"],
    };
  }
  const todayText = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const historyEnd = new Date(`${todayText}T00:00:00Z`); historyEnd.setUTCDate(historyEnd.getUTCDate() - 1);
  const historyStart = new Date(historyEnd); historyStart.setUTCDate(historyStart.getUTCDate() - 55);
  const historyFilters = reportService.normalizeFilters({
    ...filters,
    fromDate: historyStart.toISOString().slice(0, 10),
    toDate: historyEnd.toISOString().slice(0, 10),
  });
  const historyReport = await reportService.runSalesDimension(pool, user, historyFilters, "day");
  const map = new Map((historyReport.rows || []).map((row) => [String(row.Label), { Amount: Number(row.Amount || 0), Quantity: Number(row.Quantity || 0) }]));
  const history = [];
  for (let cursor = new Date(historyStart); cursor <= historyEnd; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const label = cursor.toISOString().slice(0, 10);
    const row = map.get(label) || { Amount: 0, Quantity: 0 };
    history.push({ Label: label, weekday: cursor.getUTCDay(), Amount: row.Amount, Quantity: row.Quantity });
  }
  const targetKey = intent === "demand" || isQuantityQuestion(question) ? "Quantity" : "Amount";
  const targetValues = history.map((row) => Number(row[targetKey] || 0));
  const activeDays = targetValues.filter((value) => Math.abs(value) > 0).length;
  if (activeDays < 7) {
    return {
      mode: "forecast",
      answer: localizedText(language, {
        english: "I do not have enough matching live history to make a reliable forecast for this scope. Please widen the product/branch scope or use a period with more sales history.",
        roman: "Is scope mein reliable forecast ke liye matching live history kam hai. Product/branch scope widen karein ya zyada history wala scope use karein.",
        urdu: "اس دائرے میں قابلِ اعتماد پیش گوئی کے لیے کافی لائیو تاریخ موجود نہیں۔ پروڈکٹ/برانچ کا دائرہ وسیع کریں یا زیادہ تاریخی ڈیٹا والا دائرہ استعمال کریں۔",
      }),
      rows: [], visualization: null,
      prediction: { type: intent, confidence: "Low", basis: "Insufficient matching history", horizon: window },
    };
  }
  const last14 = history.slice(-14);
  const previous14 = history.slice(-28, -14);
  const recentAvg = average(last14.map((row) => Number(row[targetKey] || 0)));
  const previousAvg = average(previous14.map((row) => Number(row[targetKey] || 0)));
  const rawTrend = previousAvg === 0 ? 1 : recentAvg / previousAvg;
  const trendMultiplier = clamp(1 + (clamp(rawTrend, 0.5, 1.5) - 1) * 0.45, 0.78, 1.22);

  const predictions = [];
  const start = new Date(`${window.fromDate}T00:00:00Z`);
  const end = new Date(`${window.toDate}T00:00:00Z`);
  for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const weekday = cursor.getUTCDay();
    const sameWeekday = history.filter((row) => row.weekday === weekday).slice(-8);
    const amountBase = weightedAverage(sameWeekday.map((row) => row.Amount));
    const qtyBase = weightedAverage(sameWeekday.map((row) => row.Quantity));
    predictions.push({
      Label: cursor.toISOString().slice(0, 10),
      Amount: Math.max(0, amountBase * trendMultiplier),
      Quantity: Math.max(0, qtyBase * trendMultiplier),
    });
  }
  const totalAmount = predictions.reduce((sum, row) => sum + Number(row.Amount || 0), 0);
  const totalQuantity = predictions.reduce((sum, row) => sum + Number(row.Quantity || 0), 0);
  const mean = average(targetValues);
  const cv = mean === 0 ? 9 : standardDeviation(targetValues) / Math.abs(mean);
  const confidence = activeDays >= 35 && cv <= 0.8 ? "High" : activeDays >= 21 && cv <= 1.25 ? "Medium" : "Low";
  const metricValue = targetKey === "Quantity" ? totalQuantity : totalAmount;
  const metricFormatted = targetKey === "Quantity" ? formatNumberValue(metricValue, "number") : formatNumberValue(metricValue, "currency");
  const metricLabel = intent === "demand"
    ? localizedText(language, { english: "predicted demand quantity", roman: "predicted demand quantity", urdu: "متوقع طلب کی مقدار" })
    : targetKey === "Quantity"
      ? localizedText(language, { english: "predicted sales quantity", roman: "predicted sales quantity", urdu: "متوقع سیلز مقدار" })
      : localizedText(language, { english: "predicted sales", roman: "predicted sales", urdu: "متوقع سیلز" });
  const confidenceText = language === "urdu" ? (confidence === "High" ? "زیادہ" : confidence === "Medium" ? "درمیانہ" : "کم") : confidence;
  const answer = language === "urdu"
    ? `AI پیش گوئی (${window.fromDate} سے ${window.toDate}): ${metricLabel} ${metricFormatted} ہے۔ اعتماد: ${confidenceText}۔ یہ اندازہ پچھلے 56 دن کے لائیو سیلز، ہفتے کے دن کے پیٹرن اور حالیہ رجحان پر مبنی ہے؛ یہ اصل ٹرانزیکشن نہیں ہے۔`
    : language === "roman"
      ? `AI Forecast (${window.fromDate} to ${window.toDate}): ${metricLabel} ${metricFormatted} hai. Confidence: ${confidence}. Ye estimate pichlay 56 din ke live sales, weekday pattern aur recent trend par based hai; actual transaction nahi hai.`
      : `AI Forecast (${window.fromDate} to ${window.toDate}): ${metricLabel} is ${metricFormatted}. Confidence: ${confidence}. This estimate uses the last 56 days of live sales, weekday patterns, and recent trend; it is not an actual transaction.`;
  const chartMetric = targetKey === "Quantity" ? "Quantity" : "Amount";
  return {
    mode: "forecast",
    answer,
    keyPoints: [], actions: [], rows: predictions,
    visualization: { type: "line", title: language === "urdu" ? "AI پیش گوئی" : "AI Forecast", data: predictions.map((row) => ({ Label: row.Label, [chartMetric]: row[chartMetric] })) },
    prediction: { type: intent, metric: chartMetric, value: metricValue, confidence, basis: "56-day weekday-weighted live sales with bounded recent-trend adjustment", horizon: window },
  };
}

function addAssistantListFilter(request, clauses, expression, prefix, values = []) {
  const clean = [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 100);
  if (!clean.length) return;
  const params = clean.map((value, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.NVarChar(120), value);
    return `@${name}`;
  });
  clauses.push(`${expression} IN (${params.join(",")})`);
}

async function currentStockQuantity(pool, user, filters, toDate) {
  const request = pool.request();
  request.timeout = Math.min(aiConfig.sqlTimeoutMs, 20000);
  request.input("companyCode", sql.VarChar(20), String(user.companyCode || ""));
  request.input("toDate", sql.Date, toDate);
  const clauses = [];
  addAssistantListFilter(request, clauses, "x.Branch", "assistantStockBranch", filters.branches || []);
  addAssistantListFilter(request, clauses, "x.StoreCode", "assistantStockStore", filters.stores || []);
  addAssistantListFilter(request, clauses, "x.BarCode", "assistantStockBarcode", filters.barcodes || []);
  const scope = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await request.query(`WITH Movements AS (
    SELECT Branch,StoreCode,BarCode,ISNULL(Quantity,0) Qty FROM PosBarOpen WHERE CompanyCode=@companyCode
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,ISNULL(d.Quantity,0) FROM PosPurchaseD d INNER JOIN PosPurchaseM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber AND m.Branch=d.Branch WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND m.Date<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,-ISNULL(d.Quantity,0) FROM PosPReturnD d INNER JOIN PosPReturnM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber AND m.Branch=d.Branch WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND m.Date<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,-ISNULL(d.Quantity,0) FROM PosDetail d WHERE d.CompanyCode=@companyCode AND d.TranDate<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,-ISNULL(d.Quantity,0) FROM UnPosDetail d WHERE d.CompanyCode=@companyCode AND d.TranDate<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCodeFrom,d.BarCode,-ISNULL(d.Quantity,0) FROM PosTransferD d INNER JOIN PosTransferM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber AND m.Branch=d.Branch WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND m.TransactionDate<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branchto,d.StoreCodeTo,d.BarCode,ISNULL(d.RecQuantity,0) FROM PosTransferD d INNER JOIN PosTransferM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber AND m.Branch=d.Branch WHERE d.CompanyCode=@companyCode AND d.RecStatus='Y' AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND d.RecDate<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,CASE WHEN d.EntryType='IN' THEN ISNULL(d.Quantity,0) WHEN d.EntryType='OUT' THEN -ISNULL(d.Quantity,0) ELSE 0 END FROM PosStockAdjD d INNER JOIN PosStockAdjM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber AND m.Branch=d.Branch WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND m.TransactionDate<DATEADD(day,1,@toDate)
  ) SELECT SUM(ISNULL(x.Qty,0)) Quantity FROM Movements x ${scope};`);
  return Number(result.recordset?.[0]?.Quantity || 0);
}

async function buildStockPrediction({ pool, user, filters, question, language, intent, window }) {
  const todayText = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const currentStock = await currentStockQuantity(pool, user, filters, todayText);
  const demandWindow = window || (() => {
    const start = new Date(`${todayText}T00:00:00Z`); start.setUTCDate(start.getUTCDate() + 1);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 29);
    return { fromDate: start.toISOString().slice(0, 10), toDate: end.toISOString().slice(0, 10), days: 30 };
  })();
  const demand = await buildSalesForecast({ pool, user, filters, question: `${question} quantity`, language, intent: "demand", window: demandWindow });
  if (!Array.isArray(demand.rows) || !demand.rows.length) return demand;
  const totalDemand = demand.rows.reduce((sum, row) => sum + Math.max(0, Number(row.Quantity || 0)), 0);
  const avgDailyDemand = totalDemand / Math.max(1, demandWindow.days);
  const confidence = demand.prediction?.confidence || "Low";

  if (intent === "stock") {
    const projectedClosing = currentStock - totalDemand;
    const answer = language === "urdu"
      ? `AI اسٹاک پیش گوئی (${demandWindow.fromDate} سے ${demandWindow.toDate}): متوقع اختتامی اسٹاک ${formatNumberValue(projectedClosing)} یونٹس ہے۔ یہ موجودہ اسٹاک ${formatNumberValue(currentStock)} میں سے متوقع طلب ${formatNumberValue(totalDemand)} نکال کر حاصل کیا گیا ہے۔ اعتماد: ${confidence === "High" ? "زیادہ" : confidence === "Medium" ? "درمیانہ" : "کم"}۔`
      : language === "roman"
        ? `AI Stock Forecast (${demandWindow.fromDate} to ${demandWindow.toDate}): predicted closing stock ${formatNumberValue(projectedClosing)} units hai. Ye current stock ${formatNumberValue(currentStock)} minus predicted demand ${formatNumberValue(totalDemand)} par based hai. Confidence: ${confidence}.`
        : `AI Stock Forecast (${demandWindow.fromDate} to ${demandWindow.toDate}): predicted closing stock is ${formatNumberValue(projectedClosing)} units, based on current stock ${formatNumberValue(currentStock)} minus predicted demand ${formatNumberValue(totalDemand)}. Confidence: ${confidence}.`;
    return { mode: "forecast", answer, keyPoints: [], actions: [], rows: demand.rows, visualization: demand.visualization, prediction: { type: "stock", confidence, currentStock, predictedDemand: totalDemand, projectedClosingStock: projectedClosing, horizon: demandWindow } };
  }

  if (intent === "stockout") {
    if (currentStock <= 0) {
      const answer = localizedText(language, {
        english: `AI Stockout Prediction: current stock is ${formatNumberValue(currentStock)}; this scope is already at or below zero stock.`,
        roman: `AI Stockout Prediction: current stock ${formatNumberValue(currentStock)} hai; ye scope already zero ya negative stock par hai.`,
        urdu: `AI اسٹاک آؤٹ پیش گوئی: موجودہ اسٹاک ${formatNumberValue(currentStock)} ہے؛ یہ دائرہ پہلے ہی صفر یا منفی اسٹاک پر ہے۔`,
      });
      return { mode: "forecast", answer, keyPoints: [], actions: [], rows: [], visualization: null, prediction: { type: "stockout", confidence, currentStock, daysCover: 0 } };
    }
    if (avgDailyDemand <= 0) {
      return { mode: "forecast", answer: localizedText(language, {
        english: "AI Stockout Prediction: recent matching demand is zero/negative, so a meaningful stockout date cannot be estimated.",
        roman: "AI Stockout Prediction: recent matching demand zero/negative hai, is liye meaningful stockout date estimate nahi ho sakti.",
        urdu: "AI اسٹاک آؤٹ پیش گوئی: حالیہ متعلقہ طلب صفر یا منفی ہے، اس لیے قابلِ معنی اسٹاک آؤٹ تاریخ کا اندازہ نہیں لگایا جا سکتا۔",
      }), keyPoints: [], actions: [], rows: [], visualization: null, prediction: { type: "stockout", confidence: "Low", currentStock } };
    }
    const daysCover = currentStock / avgDailyDemand;
    const date = new Date(`${todayText}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + Math.max(1, Math.ceil(daysCover)));
    const stockoutDate = date.toISOString().slice(0, 10);
    const answer = language === "urdu"
      ? `AI اسٹاک آؤٹ پیش گوئی: موجودہ اسٹاک ${formatNumberValue(currentStock)} ہے اور حالیہ طلب کے مطابق تقریباً ${formatNumberValue(daysCover)} دن کا کور بنتا ہے۔ متوقع اسٹاک آؤٹ تاریخ ${stockoutDate} ہے۔ اعتماد: ${confidence === "High" ? "زیادہ" : confidence === "Medium" ? "درمیانہ" : "کم"}۔`
      : language === "roman"
        ? `AI Stockout Prediction: current stock ${formatNumberValue(currentStock)} hai aur recent demand ke hisab se taqreeban ${formatNumberValue(daysCover)} din ka cover hai. Predicted stockout date ${stockoutDate} hai. Confidence: ${confidence}.`
        : `AI Stockout Prediction: current stock is ${formatNumberValue(currentStock)}, giving about ${formatNumberValue(daysCover)} days of cover at recent demand. Predicted stockout date: ${stockoutDate}. Confidence: ${confidence}.`;
    return { mode: "forecast", answer, keyPoints: [], actions: [], rows: demand.rows, visualization: null, prediction: { type: "stockout", confidence, currentStock, averageDailyDemand: avgDailyDemand, daysCover, stockoutDate } };
  }

  const required = Math.max(0, totalDemand - currentStock);
  const answer = language === "urdu"
    ? `AI ری آرڈر اندازہ (${demandWindow.fromDate} سے ${demandWindow.toDate}): تجویز کردہ اضافی مقدار ${formatNumberValue(required)} یونٹس ہے۔ حساب متوقع طلب ${formatNumberValue(totalDemand)} منفی موجودہ اسٹاک ${formatNumberValue(currentStock)} پر مبنی ہے۔ اعتماد: ${confidence === "High" ? "زیادہ" : confidence === "Medium" ? "درمیانہ" : "کم"}۔`
    : language === "roman"
      ? `AI Reorder Estimate (${demandWindow.fromDate} to ${demandWindow.toDate}): suggested additional quantity ${formatNumberValue(required)} units hai. Calculation predicted demand ${formatNumberValue(totalDemand)} minus current stock ${formatNumberValue(currentStock)} par based hai. Confidence: ${confidence}.`
      : `AI Reorder Estimate (${demandWindow.fromDate} to ${demandWindow.toDate}): suggested additional quantity is ${formatNumberValue(required)} units, based on predicted demand ${formatNumberValue(totalDemand)} minus current stock ${formatNumberValue(currentStock)}. Confidence: ${confidence}.`;
  return { mode: "forecast", answer, keyPoints: [], actions: [], rows: demand.rows, visualization: demand.visualization, prediction: { type: "reorder", confidence, currentStock, predictedDemand: totalDemand, suggestedQuantity: required, horizon: demandWindow } };
}

async function getSchema(pool, requestedTables) {
  const safe = requestedTables.filter((name) => allowedTables.includes(name));
  if (!safe.length) return { tables: [], schemaText: "" };
  const request = pool.request();
  const params = safe.map((name, index) => {
    request.input(`table${index}`, sql.NVarChar(128), name);
    return `@table${index}`;
  });
  const result = await request.query(`SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN (${params.join(",")}) ORDER BY TABLE_NAME,ORDINAL_POSITION`);
  const grouped = {};
  for (const row of result.recordset || []) (grouped[row.TABLE_NAME] ||= []).push(`${row.COLUMN_NAME}:${row.DATA_TYPE}`);
  return {
    tables: Object.keys(grouped),
    schemaText: Object.entries(grouped).map(([name, columns]) => `${name}(${columns.join(", ")})`).join("\n"),
  };
}

async function executePlannedSql(pool, user, filters, query, liveTables) {
  const validation = validateReadOnlySql(query, liveTables);
  if (String(user.companyCode || "").trim() && !/@companyCode\b/i.test(validation.sql)) throw new Error("AI query was blocked because company isolation was missing");
  const request = pool.request();
  request.timeout = aiConfig.sqlTimeoutMs;
  request.input("companyCode", sql.VarChar(20), String(user.companyCode || ""));
  request.input("fromDate", sql.Date, filters.fromDate);
  request.input("toDate", sql.Date, filters.toDate);
  const result = await request.query(validation.sql);
  return (result.recordset || []).slice(0, aiConfig.maxRows);
}


function normalizedPhrase(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function phraseAppears(question, value) {
  const q = ` ${normalizedPhrase(question)} `;
  const candidate = normalizedPhrase(value);
  if (!candidate || candidate.length < 3) return false;
  return q.includes(` ${candidate} `) || q.includes(` ${candidate}`) || q.includes(`${candidate} `);
}

async function resolveNamedBusinessFilters(pool, user, question, filters) {
  const resolved = { ...filters };
  try {
    const request = pool.request();
    request.timeout = Math.min(aiConfig.sqlTimeoutMs, 15000);
    request.input("companyCode", sql.VarChar(20), String(user.companyCode || ""));
    const result = await request.query(`
      SELECT TOP 500 BranchCode code, BranchName label FROM BranchFile
      WHERE CompanyCode=@companyCode AND ISNULL(BranchName,'')<>'' ORDER BY LEN(BranchName) DESC;
      SELECT TOP 1000 sr.Code code, sr.Name label, sr.Branch branchCode
      FROM StockRoom sr INNER JOIN BranchFile bf ON bf.BranchCode=sr.Branch
      WHERE bf.CompanyCode=@companyCode AND ISNULL(sr.Name,'')<>'' ORDER BY LEN(sr.Name) DESC;
    `);
    if (!resolved.branches?.length) {
      const branch = (result.recordsets?.[0] || []).find((row) => phraseAppears(question, row.label) || phraseAppears(question, row.code));
      if (branch) resolved.branches = [String(branch.code)];
    }
    if (!resolved.stores?.length) {
      const store = (result.recordsets?.[1] || []).find((row) => phraseAppears(question, row.label) || phraseAppears(question, row.code));
      if (store) {
        resolved.stores = [String(store.code)];
        if (!resolved.branches?.length && store.branchCode) resolved.branches = [String(store.branchCode)];
      }
    }
  } catch (error) {
    console.warn("[AI Assistant] Natural branch/store resolution skipped:", error.message);
  }
  return resolved;
}

function reportHasMeaningfulData(report) {
  if ((report?.rows || []).length) return true;
  return (report?.kpis || []).some((kpi) => Math.abs(Number(kpi?.value || 0)) > 0);
}

async function latestActivityHint(pool, user, code) {
  const companyCode = String(user.companyCode || "");
  if (!companyCode) return null;
  const request = pool.request();
  request.timeout = Math.min(aiConfig.sqlTimeoutMs, 15000);
  request.input("companyCode", sql.VarChar(20), companyCode);
  let query = null;
  if (/^RPT_02_/.test(code) || /^RPT_26_/.test(code)) {
    query = `SELECT MAX(ActivityDate) LatestDate FROM (SELECT MAX(TranDate) ActivityDate FROM PosDetail WHERE CompanyCode=@companyCode UNION ALL SELECT MAX(TranDate) FROM UnPosDetail WHERE CompanyCode=@companyCode) x`;
  } else if (/^RPT_05_/.test(code)) {
    query = `SELECT MAX(ActivityDate) LatestDate FROM (SELECT MAX(Date) ActivityDate FROM PosPurchaseM WHERE CompanyCode=@companyCode UNION ALL SELECT MAX(Date) FROM PosPReturnM WHERE CompanyCode=@companyCode) x`;
  } else if (/^RPT_06_/.test(code)) {
    query = `SELECT MAX(TransactionDate) LatestDate FROM PosTransferM WHERE CompanyCode=@companyCode`;
  }
  if (!query) return null;
  try {
    const result = await request.query(query);
    const value = result.recordset?.[0]?.LatestDate;
    if (!value) return null;
    return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", day: "2-digit", month: "short", year: "numeric" }).format(new Date(value));
  } catch {
    return null;
  }
}

async function plannerFallback({ pool, user, message, history, filters, language = "english" }) {
  const relevant = selectRelevantTables(message);
  const schema = await getSchema(pool, relevant);
  const system = `You plan safe SQL Server 2014 queries for Cherry POS. Current question overrides history.
Return JSON only: {"mode":"sql|clarify|direct","sql":"","question":"","answer":""}.
Use one read-only SELECT or CTE only, no semicolon/comments, no SELECT *, and TOP ${aiConfig.maxRows} for non-aggregate detail.
When authenticated companyCode is non-blank, every CompanyCode-bearing transaction query MUST filter CompanyCode=@companyCode. Use @fromDate and @toDate for the requested period.
Detail tables are facts. For dashboard-compatible sales, combine PosDetail + UnPosDetail with UNION ALL, preserve signed returns, use detail TranDate, and do not make totals depend on BillStatus or Pos/UnPos dedupe.
Never invent a field or relation. If required logic/table is absent, clarify. Money is PKR.
Answer-scope rule: answer ONLY the metric/dimension the user asked for. Do not append Net Sales, Quantity, Bills, Discount, Profit or other KPIs unless requested or necessary for the specific reasoning question.
If the question is materially ambiguous, return mode=clarify with one focused cross-question instead of guessing.
Rules:\n${businessRules.join("\n")}\n\nNatural conversation training:\n${getConversationTrainingPrompt()}
Table purposes:\n${Object.entries(tablePurposes).filter(([name]) => schema.tables.includes(name)).map(([name, purpose]) => `${name}: ${purpose}`).join("\n")}
Training workbook context:\n${trainingContextForTables(schema.tables, message)}
Live schema:\n${schema.schemaText}`;
  const planner = await ollamaChat([
    { role: "system", content: system },
    ...history.slice(-4).map((item) => ({ role: item.role === "assistant" ? "assistant" : "user", content: String(item.content || "").slice(0, 600) })),
    { role: "user", content: `${message}\nResolved period: ${filters.fromDate} to ${filters.toDate}` },
  ], {
    json: true,
    temperature: 0,
    timeoutMs: Math.min(aiConfig.ollamaTimeoutMs, 20000),
    numCtx: 8192,
    numPredict: 320,
    // SQL planning must stay fast/stable. Deep reasoning is reserved for the
    // final management explanation so Vercel/mobile requests do not time out.
    think: false,
  });
  if (planner.mode === "clarify") return { mode: "clarify", answer: String(planner.question || "Please clarify the missing business scope.") };
  if (planner.mode === "direct") return { mode: "direct", answer: String(planner.answer || "") };
  if (planner.mode !== "sql" || !planner.sql) throw new Error("AI planner returned an invalid plan");
  const rows = await executePlannedSql(pool, user, filters, planner.sql, schema.tables);
  const responseLanguage = language === "urdu" ? "Urdu script" : language === "roman" ? "clear Roman Urdu" : "clear business English";
  const answer = await ollamaChat([
    { role: "system", content: `Answer in ${responseLanguage}. Use ONLY the supplied live rows. Keep exact numbers. Answer ONLY what the user asked; do not append unrelated KPIs. Do not expose SQL. If rows are empty, say no matching live data was found.` },
    { role: "user", content: JSON.stringify({ question: message, period: filters, rows: rows.slice(0, 40) }) },
  ], {
    temperature: 0.1,
    timeoutMs: Math.min(aiConfig.ollamaTimeoutMs, 35000),
    numCtx: 8192,
    numPredict: 520,
    think: analysisThinkLevelForQuestion(message),
  });
  return { mode: "sql", answer, rows, visualization: inferVisualization(rows) };
}

function inferVisualization(rows) {
  if (!rows?.length) return null;
  const columns = Object.keys(rows[0]);
  const label = columns.find((key) => typeof rows[0][key] === "string");
  const numeric = columns.find((key) => Number.isFinite(Number(rows[0][key])));
  if (!label || !numeric) return null;
  return { type: "bar", title: `${numeric} by ${label}`, data: rows.slice(0, 12).map((row) => ({ Label: String(row[label] ?? ""), Amount: Number(row[numeric] || 0) })) };
}

async function answerAssistant({ tenantId, user, message, history = [], languageMode = "english-roman" }) {
  const originalQuestion = String(message || "").trim();
  const question = resolveFollowUpQuestion(originalQuestion, history);
  if (!question) throw Object.assign(new Error("Message is required"), { status: 400 });
  if (question.length > aiConfig.maxQuestionLength) throw Object.assign(new Error("Message is too long"), { status: 400 });
  const outputLanguage = resolveOutputLanguage(languageMode, originalQuestion);
  if (/^(hi|hello|hey|salam|assalam|aoa|bhai|السلام علیکم|سلام)[!. ]*$/i.test(originalQuestion)) {
    return {
      mode: "direct",
      answer: localizedText(outputLanguage, {
        english: "Hello. Ask me naturally about live sales, purchase, stock, transfer, payments, forecasts, or business analysis.",
        roman: "Walekum salam bhai. Sales, purchase, stock, transfer, payment, forecast ya business analysis ke bare mein normal language mein poochain.",
        urdu: "وعلیکم السلام۔ آپ سیلز، خریداری، اسٹاک، ٹرانسفر، ادائیگی، پیش گوئی یا کاروباری تجزیے کے بارے میں عام زبان میں پوچھ سکتے ہیں۔",
      }),
    };
  }

  const pool = await getPoolForTenant(tenantId);
  let filters = inferFilters(question);
  filters = await resolveNamedBusinessFilters(pool, user, question, filters);

  const clarification = clarificationForQuestion(originalQuestion, question, history, filters, outputLanguage);
  if (clarification) {
    return {
      mode: "clarify",
      answer: clarification.answer,
      keyPoints: [], actions: [], rows: [], visualization: null,
      followUpOptions: clarification.options || [],
    };
  }

  const predictiveIntent = forecastIntent(question);
  if (predictiveIntent) {
    const window = forecastWindow(question);
    if (predictiveIntent === "sales" || predictiveIntent === "demand") {
      return buildSalesForecast({ pool, user, filters, question, language: outputLanguage, intent: predictiveIntent, window });
    }
    if (predictiveIntent === "stockout" || predictiveIntent === "reorder" || predictiveIntent === "stock") {
      return buildStockPrediction({ pool, user, filters, question, language: outputLanguage, intent: predictiveIntent, window });
    }
  }

  // Salesman questions have a verified dimension engine even though the static
  // report catalog does not expose a generic Salesman Wise Sales code.
  const asksSalesmanSales = /\b(salesman|sales person|staff|employee)\b/i.test(question)
    && /\b(sale|sales|selling|revenue|bikri|farokht|performance|top|bottom|best|worst)\b/i.test(question);
  if (asksSalesmanSales) {
    const output = await reportService.runSalesDimension(pool, user, filters, "salesman");
    const report = {
      ...output,
      code: "CHAT_SALESMAN_WISE_SALES",
      title: "Salesman Wise Sales",
      filters,
      source: "live-database",
      generatedAt: new Date().toISOString(),
    };
    let narrative = naturalFastNarrative(report, question, outputLanguage);
    if (wantsComparison(question)) {
      const previousFilters = previousComparableFilters(filters);
      const previousOutput = await reportService.runSalesDimension(pool, user, previousFilters, "salesman");
      narrative = comparisonNarrative(report, { ...previousOutput, filters: previousFilters }, question, outputLanguage);
    }
    return assistantAnswerFromReport(report, narrative, question);
  }

  const fastCode = chooseFastReport(question);
  if (fastCode) {
    const report = await reportService.runReport({ tenantId, user, code: fastCode, filters });
    let narrative = naturalFastNarrative(report, question, outputLanguage);
    if (wantsComparison(question)) {
      const previousFilters = previousComparableFilters(filters);
      const previousReport = await reportService.runReport({ tenantId, user, code: fastCode, filters: previousFilters });
      narrative = comparisonNarrative(report, previousReport, question, outputLanguage);
    }
    const result = assistantAnswerFromReport(report, narrative, question);
    if (!reportHasMeaningfulData(report)) {
      const latest = await latestActivityHint(pool, user, fastCode);
      if (latest) {
        const scope = `${report.filters?.fromDate || filters.fromDate} to ${report.filters?.toDate || filters.toDate}`;
        result.answer = localizedText(outputLanguage, {
          english: `The requested scope (${scope}) has no matching live data. The latest related activity for this company is ${latest}.`,
          roman: `Requested scope (${scope}) mein matching live data 0 hai. Is company ki latest related activity ${latest} ko mili hai.`,
          urdu: `درخواست کردہ مدت (${scope}) میں متعلقہ لائیو ڈیٹا صفر ہے۔ اس کمپنی کی تازہ ترین متعلقہ سرگرمی ${latest} کو ملی۔`,
        });
        result.warning = "Zero was verified against the requested scope; latest same-company activity was checked before returning the answer.";
      }
    }
    return result;
  }

  const analysisCode = chooseVerifiedAnalysisReport(question);
  if (analysisCode) {
    const currentReport = await reportService.runReport({ tenantId, user, code: analysisCode, filters });
    let previousReport = null;
    if (/\b(why|kyun|reason|cause|trend|growth|decline|compare|comparison|performance|analysis|analyze|analyse)\b/i.test(question)
      || /(کیوں|وجہ|رجحان|اضافہ|کمی|موازنہ|تجزیہ)/i.test(question)) {
      try {
        const previousFilters = previousComparableFilters(currentReport.filters || filters);
        previousReport = await reportService.runReport({ tenantId, user, code: analysisCode, filters: previousFilters });
      } catch (error) {
        console.warn("[AI Assistant] Previous comparable analysis scope skipped:", error.message);
      }
    }
    const narrative = await generateAssistantBusinessAnalysis({ currentReport, previousReport, question, language: outputLanguage });
    const result = assistantAnswerFromReport(currentReport, narrative, question);
    result.mode = "analysis";
    return result;
  }

  try {
    return await plannerFallback({ pool, user, message: question, history: Array.isArray(history) ? history : [], filters, language: outputLanguage });
  } catch (error) {
    console.warn("[AI Assistant] Bounded planner fallback:", error.message);
    return {
      mode: "clarify",
      answer: localizedText(outputLanguage, {
        english: "I could not map this question to one safe business interpretation. Please make the metric, period, branch, or product a little more specific.",
        roman: "Is sawal ki ek safe business interpretation clear nahi hui. Metric, period, branch ya product thora specific kar dein.",
        urdu: "اس سوال کی ایک واضح اور محفوظ کاروباری تشریح نہیں بن سکی۔ میٹرک، مدت، برانچ یا پروڈکٹ کو تھوڑا واضح کر دیں۔",
      }),
      followUpOptions: [],
    };
  }
}

module.exports = {
  generateReportNarrative,
  fallbackReportNarrative,
  answerAssistant,
  chooseFastReport,
  inferFilters,
  resolveFollowUpQuestion,
  detectRomanUrdu,
  resolveOutputLanguage,
  forecastIntent,
  forecastWindow,
  naturalFastNarrative,
  clarificationForQuestion,
  businessAnalysisIntent,
  chooseVerifiedAnalysisReport,
};
