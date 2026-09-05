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
const accountingReportService = require("./accountingReportService");
const { getDatabaseCatalog, compactSchema } = require("./aiDatabaseService");
const { getConversationTrainingPrompt } = require("../ai/conversationTraining");
const { canonicalizeForRouting, looksRomanUrdu, conceptsForText } = require("../ai/posLanguage");
const { getQuestionBankTrainingPrompt } = require("../ai/questionBankTraining");
const {
  resolveTrainingIntent,
  verifyReportRoute,
  groundingMetadata,
  HUMAN_DOMAIN,
} = require("../ai/trainingIntentResolver");
const { answerSchemaQuestion, isSchemaKnowledgeQuestion } = require("../ai/schemaTrainingAnswer");
const { resolveSemanticTrainingIntent, semanticGroundingMetadata } = require("../ai/trainingSemanticRouter");

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
  return looksRomanUrdu(text) || /\b(bhai|batao|btao|kitna|kitni|kitne|aaj|aj|kal|parson|iss|is month|pichla|pichlay|branch wise|ka|ki|ke|ko|mera|meri|mujhe|maal|bikri|farokht|khareed|kharid|wapsi|wapas|konsi|kaunsi|sab se|zyada|kam|kyun|q|samjhao|dikhao)\b/i.test(String(text || ""));
}

function resolveOutputLanguage(languageMode, question) {
  const selected = String(languageMode || "english-roman").trim().toLowerCase();
  if (selected === "urdu" || selected === "ur" || selected.includes("اردو")) return "urdu";
  return detectRomanUrdu(question) ? "roman" : "english";
}

function localizedText(language, values) {
  return values[language] || values.english || "";
}

function semanticClarification(semantic, language = "english") {
  const intent = semantic?.intent || {};
  const conflicts = semantic?.conflicts || {};
  if (conflicts.intrinsicAmbiguity && intent.dimension === "branch" && (intent.metrics || []).includes("quantity")) {
    return {
      answer: localizedText(language, {
        english: "Branch-wise quantity of what — sales quantity, purchase quantity, or current stock?",
        roman: "Branch/shop wise quantity kis cheez ki chahiye — sales quantity, purchase quantity, ya current stock?",
        urdu: "برانچ/دکان وائز مقدار کس چیز کی چاہیے — سیلز مقدار، خریداری مقدار یا موجودہ اسٹاک؟",
      }),
      options: language === "urdu" ? ["سیلز مقدار", "خریداری مقدار", "موجودہ اسٹاک"] : ["Sales quantity", "Purchase quantity", "Current stock"],
    };
  }
  if (conflicts.intrinsicAmbiguity && intent.dimension === "branch" && (intent.metrics || []).includes("amount")) {
    return {
      answer: localizedText(language, {
        english: "Branch-wise amount of what — sales, purchases, stock value, or payments?",
        roman: "Branch/shop wise amount kis cheez ka chahiye — sales, purchase, stock value, ya payments?",
        urdu: "برانچ/دکان وائز رقم کس چیز کی چاہیے — سیلز، خریداری، اسٹاک ویلیو یا ادائیگیاں؟",
      }),
      options: language === "urdu" ? ["سیلز", "خریداری", "اسٹاک ویلیو", "ادائیگیاں"] : ["Sales", "Purchase", "Stock value", "Payments"],
    };
  }
  return null;
}

function trainingClarification(understanding, language = "english") {
  const candidates = (understanding?.topDomains || [])
    .filter((item) => item?.domain && item.domain !== "ai-analysis" && item.domain !== "schema")
    .slice(0, 3);
  const labels = candidates.map((item) => item.label || HUMAN_DOMAIN[item.domain] || item.domain);
  if (!labels.length) {
    return {
      answer: localizedText(language, {
        english: "I do not have enough confidence to map this wording to one verified POS meaning. Please specify the metric and business area instead of letting me guess.",
        roman: "Is wording ko ek verified POS meaning par map karne ka confidence enough nahi hai. Metric aur business area thora clear kar dein; main guess karke ghalat jawab nahi dunga.",
        urdu: "اس عبارت کو ایک تصدیق شدہ POS مطلب سے جوڑنے کا اعتماد کافی نہیں ہے۔ براہِ کرم میٹرک اور کاروباری حصہ واضح کریں؛ میں اندازہ لگا کر غلط جواب نہیں دوں گا۔",
      }),
      options: [],
    };
  }
  const joined = labels.join(" / ");
  return {
    answer: localizedText(language, {
      english: `I can read this in more than one way (${joined}). Which one do you mean?`,
      roman: `Is sawal ke ek se zyada possible meanings hain (${joined}). Aap kis meaning ki baat kar rahe hain?`,
      urdu: `اس سوال کے ایک سے زیادہ ممکنہ مطلب ہیں (${joined})۔ آپ کس مطلب کی بات کر رہے ہیں؟`,
    }),
    options: labels.map((label) => language === "urdu" ? label : `Show ${label}`),
  };
}

function withTrainingGrounding(result, understanding, extra = {}) {
  return {
    ...result,
    grounding: groundingMetadata(understanding, extra),
  };
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

function resolveFollowUpQuestion(message, history = [], memory = null) {
  const current = String(message || "").trim();
  const currentRouting = canonicalizeForRouting(current);
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
  const isFollowUpLike = (value) => {
    const routed = canonicalizeForRouting(value);
    return followUpPattern.test(routed)
    || followUpContainsPattern.test(routed)
    || urduFollowUpPattern.test(String(value || "").trim())
    || /^\d{3,18}$/.test(String(value || "").trim())
    || (lastAssistantAsked && compactReply);
  };

  const hasBusinessSubject = businessSubjectPattern.test(currentRouting) || urduBusinessSubjectPattern.test(current);
  const looksLikeFollowUp = isFollowUpLike(current);
  if (hasBusinessSubject && !looksLikeFollowUp) return current;
  if (!looksLikeFollowUp) return current;

  const userHistory = (Array.isArray(history) ? history : [])
    .filter((item) => item?.role === "user" && String(item.content || "").trim())
    .map((item) => String(item.content || "").trim());
  const memoryAnchor = String(memory?.anchorQuestion || memory?.resolvedQuestion || "").trim();
  if (!userHistory.length && !memoryAnchor) return current;
  if (!userHistory.length && memoryAnchor) {
    return [memoryAnchor, `Follow-up request: ${current}`].join("\n");
  }

  const anchorSubjectPattern = /\b(sale|sales|selling|revenue|bikri|farokht|purchase|purchasing|kharid|khareed|stock|inventory|maal|transfer|payment|cash|card|credit|discount|profit|margin|return|wapsi|bill|invoice|report)\b/i;
  const urduAnchorPattern = /(سیلز|فروخت|خریداری|اسٹاک|انوینٹری|ٹرانسفر|ادائیگی|کیش|کارڈ|کریڈٹ|ڈسکاؤنٹ|منافع|مارجن|واپسی|بل|انوائس|رپورٹ)/i;
  let anchorIndex = -1;
  for (let index = userHistory.length - 1; index >= 0; index -= 1) {
    if (anchorSubjectPattern.test(canonicalizeForRouting(userHistory[index])) || urduAnchorPattern.test(userHistory[index])) {
      anchorIndex = index;
      break;
    }
  }
  if (anchorIndex < 0) {
    for (let index = userHistory.length - 1; index >= 0; index -= 1) {
      if (businessSubjectPattern.test(canonicalizeForRouting(userHistory[index])) || urduBusinessSubjectPattern.test(userHistory[index])) { anchorIndex = index; break; }
    }
  }
  if (anchorIndex < 0) anchorIndex = Math.max(0, userHistory.length - 1);

  const anchor = userHistory[anchorIndex] || memoryAnchor;
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
  const genericLastDays = periodText.match(/\b(?:last|previous|pichl[aei]y?)\s+(\d{1,3})\s*(?:days?|din)\b/i);
  const quarterStart = (date) => new Date(Date.UTC(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) * 3, 1));

  if (/\b(aaj|aj|today)\b/i.test(periodText) || /آج/i.test(periodText)) fromDate = toDate = today;
  else if (/\b(yesterday|kal)\b/i.test(periodText) || /کل/i.test(periodText)) {
    const date = new Date(current); date.setUTCDate(date.getUTCDate() - 1);
    fromDate = toDate = iso(date);
  } else if (genericLastDays) setDaysAgo(Math.min(365, Math.max(1, Number(genericLastDays[1]))));
  else if (/\b(month to date|mtd|this month|current month|iss? month|is month)\b/i.test(periodText) || /(اس|موجودہ)\s*مہین/i.test(periodText)) {
    fromDate = `${today.slice(0, 8)}01`; toDate = today;
  } else if (/\b(year to date|ytd|this year|current year|iss? year|is saal)\b/i.test(periodText) || /اس\s*سال/i.test(periodText)) {
    fromDate = `${current.getUTCFullYear()}-01-01`; toDate = today;
  } else if (/\b(this|current|iss?|is)\s+quarter\b/i.test(periodText) || /اس\s*کوارٹر/i.test(periodText)) {
    fromDate = iso(quarterStart(current)); toDate = today;
  } else if (/\b(last|previous|pichl[aei]y?)\s+quarter\b/i.test(periodText) || /(پچھلے|گزشتہ)\s*کوارٹر/i.test(periodText)) {
    const thisQ = quarterStart(current);
    const lastEnd = new Date(thisQ); lastEnd.setUTCDate(lastEnd.getUTCDate() - 1);
    const lastStart = quarterStart(lastEnd);
    fromDate = iso(lastStart); toDate = iso(lastEnd);
  } else if (/\b(this|current|iss?|is)\s+week\b/i.test(periodText)) {
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

  const monthIndexByName = { january:0, jan:0, february:1, feb:1, march:2, mar:2, april:3, apr:3, may:4, june:5, jun:5, july:6, jul:6, august:7, aug:7, september:8, sep:8, sept:8, october:9, oct:9, november:10, nov:10, december:11, dec:11 };
  const namedRange = periodText.match(/\b(\d{1,2})\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec)\s+(?:to|se|tak|-)\s+(\d{1,2})\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept?|october|oct|november|nov|december|dec)(?:\s+(20\d{2}))?\b/i);
  if (namedRange) {
    const startMonth = monthIndexByName[namedRange[2].toLowerCase()];
    const endMonth = monthIndexByName[namedRange[4].toLowerCase()];
    let year = namedRange[5] ? Number(namedRange[5]) : current.getUTCFullYear();
    if (!namedRange[5] && endMonth > current.getUTCMonth()) year -= 1;
    const startYear = startMonth > endMonth ? year - 1 : year;
    fromDate = iso(new Date(Date.UTC(startYear, startMonth, Number(namedRange[1]))));
    toDate = iso(new Date(Date.UTC(year, endMonth, Number(namedRange[3]))));
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

function hasExplicitPeriodCue(value) {
  return /\b(aaj|aj|today|kal|yesterday|this|current|last|previous|pichl[aei]y?|week|month|mahina|maheena|year|saal|quarter|mtd|ytd|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|20\d{2}|\d{1,2}[\/-]\d{1,2}[\/-]20\d{2})\b/i.test(String(value || ""))
    || /(آج|کل|اس ہفتے|پچھلے ہفتے|اس مہینے|پچھلے مہینے|اس سال|پچھلے سال|کوارٹر)/i.test(String(value || ""));
}

function looksLikeMemoryFollowUp(value) {
  const text = canonicalizeForRouting(value);
  const words = String(value || "").trim().split(/\s+/).filter(Boolean).length;
  return words <= 7 || /\b(iska|iski|iske|iss ka|uska|uski|uske|same|aur|also|then|what about|why|kyun|q|detail|breakdown|graph|chart|compare|comparison|kal|aaj|today|yesterday|top|bottom|best|worst|branch wise|store wise|product wise|supplier wise|salesman wise)\b/i.test(text)
    || /(اس کا|اسکی|اس کے|اور|کیوں|تفصیل|موازنہ|آج|کل|سب سے زیادہ|سب سے کم)/i.test(String(value || ""));
}

function inheritConversationFilters(originalQuestion, filters, memory) {
  if (!memory?.filters || !looksLikeMemoryFollowUp(originalQuestion)) return reportService.normalizeFilters(filters);
  const merged = reportService.normalizeFilters(filters);
  const previous = reportService.normalizeFilters(memory.filters);
  if (!hasExplicitPeriodCue(originalQuestion)) {
    merged.fromDate = previous.fromDate;
    merged.toDate = previous.toDate;
  }
  const listKeys = ["branches","stores","barcodes","accounts","brands","categories","seasons","styles","colors","sizes","designs","fabrics","departments","genders","cobrands","suppliers","subcategories","substyles","styleclasses","styleclass1","styleclass2","subdepartments","fabricclasses","colorclasses"];
  for (const key of listKeys) {
    if (!(merged[key] || []).length && (previous[key] || []).length) merged[key] = [...previous[key]];
  }
  return merged;
}

function chooseFastReport(message) {
  const text = canonicalizeForRouting(message);
  const concepts = conceptsForText(message);

  // Predictive/diagnostic questions are handled by dedicated logic before this
  // function. Keep genuinely open-ended causal questions on the planner path.
  if (/\b(why|kyun|reason|cause|forecast|predict|prediction|analysis|analyze|analyse|diagnostic|strategy|recommend|suggest|management action|explain anomaly|root cause)\b/i.test(text) || /(کیوں|وجہ|پیش گوئی|اندازہ|تجزیہ|حکمت عملی|مشورہ)/i.test(text)) return null;

  // Target/incentive questions have verified reports; keep them off the open SQL planner.
  if (concepts.has("target") || concepts.has("incentive")) {
    if (concepts.has("category") && concepts.has("salesman")) return "RPT_25_004_CATEGORY_SALESMAN_INCENTIVE";
    if (concepts.has("salesman")) return "RPT_25_002_SALESMAN_INCENTIVE";
    if (concepts.has("category") || concepts.has("brand") || concepts.has("supplier")) return "RPT_25_003_CATEGORY_INCENTIVE";
    return "RPT_25_001_BRANCH_TARGET_INCENTIVE";
  }

  if (concepts.has("purchase_return") || /purchase return|supplier return|purchase waps|kharid.*waps|khareed.*waps/.test(text) || /(خریداری.*واپسی|سپلائر.*واپسی)/i.test(text)) return "RPT_05_009_PURCHASE_RETURN";
  if (/discount policy|discount applies|discount lage|active discount/.test(text) || /(ڈسکاؤنٹ.*پالیسی|فعال ڈسکاؤنٹ)/i.test(text)) return "RPT_16_016_DISCOUNT_POLICY_COMPLIANCE";
  if (/fbr|gst|taxable sales|tax summary/.test(text) || /(جی ایس ٹی|ٹیکس|ایف بی آر)/i.test(text)) return "RPT_26_001_FBR_SALES_SUMMARY";
  // Supplier/vendor payment is an accounting-ledger question. Never confuse it
  // with POS cash/card/credit tender mix. The semantic direct-engine handles it.
  if (concepts.has("supplier") && concepts.has("payment") && !concepts.has("sales")) return null;
  if (/payment|cash.*card|card.*credit|cash.*credit|tender/.test(text) || /(ادائیگی|کیش|کارڈ|کریڈٹ)/i.test(text)) return "RPT_02_032_CASH_CARD_CREDIT_SALES";
  if (/transfer|in transit|received|bheja|receive/.test(text) || /(ٹرانسفر|راستے میں|موصول|بھیجا)/i.test(text)) return "RPT_06_013_SENT_VS_RECEIVED_QUANTITY";
  if (/stock take|physical stock|physical count/.test(text) || /(فزیکل اسٹاک|اسٹاک ٹیک)/i.test(text)) return "RPT_03_001_CURRENT_STOCK";
  if (/stock adjustment|stock adj/.test(text) || /(اسٹاک ایڈجسٹمنٹ)/i.test(text)) return "RPT_03_002_BARCODE_STOCK_LEDGER";

  if (/\b(stock|inventory|on hand|available|availability|maal)\b/.test(text) || /(اسٹاک|انوینٹری|موجودہ مال)/i.test(text)) {
    if (concepts.has("branch") && /\b(wise|ranking|top|bottom|best|worst|highest|lowest)\b/.test(text)) return "RPT_03_003_BRANCH_WISE_STOCK";
    if (concepts.has("stockroom") && /\b(wise|ranking|top|bottom|best|worst|highest|lowest)\b/.test(text)) return "RPT_03_004_STORE_WISE_STOCK";
    if (concepts.has("brand") && /\b(wise|ranking|top|bottom)\b/.test(text)) return "RPT_03_006_BRAND_WISE_STOCK";
    if (concepts.has("category") && /\b(wise|ranking|top|bottom)\b/.test(text)) return "RPT_03_007_CATEGORY_WISE_STOCK";
    if (concepts.has("size") && concepts.has("color")) return "RPT_03_013_SIZE_COLOR_STOCK_MATRIX";
    if (concepts.has("size") && /\b(wise|ranking|top|bottom)\b/.test(text)) return "RPT_03_011_SIZE_WISE_STOCK";
    if (concepts.has("color") && /\b(wise|ranking|top|bottom)\b/.test(text)) return "RPT_03_012_COLOR_WISE_STOCK";
    return "RPT_03_001_CURRENT_STOCK";
  }

  if (/purchase|purchasing|kharid|khareed/.test(text) || /(خریداری|خریدا|خرید)/i.test(text)) {
    if (concepts.has("supplier") || /supplier wise|party wise|vendor wise|supplier|vendor/.test(text) || /(سپلائر وائز|پارٹی وائز|سپلائر)/i.test(text)) return "RPT_05_003_SUPPLIER_WISE_PURCHASE";
    if (concepts.has("product") && /\b(barcode|item|product).*\b(wise|detail|history)|\bwise.*\b(barcode|item|product)/.test(text)) return "RPT_05_004_BARCODE_WISE_PURCHASE";
    if (concepts.has("brand") && /\bwise\b/.test(text)) return "RPT_05_006_BRAND_WISE_PURCHASE";
    if (concepts.has("category") && /\bwise\b/.test(text)) return "RPT_05_007_CATEGORY_WISE_PURCHASE";
    return "RPT_05_001_PURCHASE_REGISTER";
  }

  if (/sale|sales|selling|farokht|bikri|revenue|profit|margin/.test(text) || /(سیلز|فروخت|ریونیو|منافع|مارجن)/i.test(text)) {
    const rankedOrWise = /\b(wise|ranking|top|bottom|best|worst|highest|lowest)\b/.test(text);
    if ((concepts.has("branch") && rankedOrWise) || /branch wise|outlet wise|shop wise|dukaan wise|which branch|kis branch|konsi branch|kaunsi branch|best branch|worst branch|top.*branch|bottom.*branch/.test(text) || /(برانچ وائز|شاخ وائز|کس برانچ|سب سے زیادہ.*برانچ|سب سے کم.*برانچ)/i.test(text)) return "RPT_02_005_BRANCH_WISE_SALES";
    if ((concepts.has("stockroom") && rankedOrWise) || /store wise|stockroom wise|godown wise|which store|best store|worst store|top.*store|bottom.*store/.test(text) || /(اسٹور وائز|گودام وائز)/i.test(text)) return "RPT_02_006_STORE_WISE_SALES";
    if (concepts.has("brand") && rankedOrWise) return "RPT_02_010_BRAND_WISE_SALES";
    if (concepts.has("category") && rankedOrWise) return "RPT_02_012_CATEGORY_WISE_SALES";
    if (concepts.has("season") && rankedOrWise) return "RPT_02_017_SEASON_WISE_SALES";
    if (concepts.has("size") && concepts.has("color")) return "RPT_02_022_SIZE_COLOR_SALES_MATRIX";
    if (concepts.has("size") && rankedOrWise) return "RPT_02_020_SIZE_WISE_SALES";
    if (concepts.has("color") && rankedOrWise) return "RPT_02_021_COLOR_WISE_SALES";
    if (/barcode wise|product wise|item wise|design wise|which product|which item|top\s*\d*\s*(selling\s*)?(product|item|design|barcode)s?|bottom\s*\d*\s*(product|item|design|barcode)s?|best selling|slow selling/.test(text) || /(بارکوڈ وائز|پروڈکٹ وائز|آئٹم وائز|ڈیزائن وائز|سب سے زیادہ.*پروڈکٹ|سب سے کم.*پروڈکٹ)/i.test(text)) return "RPT_02_008_BARCODE_WISE_SALES";
    if (/daily|day wise|rozana|trend|day by day/.test(text) || /(روزانہ|دن وائز|ٹرینڈ)/i.test(text)) return "RPT_02_002_DAILY_SALES";
    if (/\b(top|bottom)\s*\d*\b/.test(text) || /(سب سے زیادہ|سب سے کم)/i.test(text)) return "RPT_02_008_BARCODE_WISE_SALES";
    return "RPT_02_001_SALES_SUMMARY";
  }
  if (concepts.has("product") && /\b(detail|details|master|name|brand|category|catagory|color|colour|size|season|price|attribute|information|info)\b/.test(text)) return "RPT_07_001_BARCODE_MASTER";
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
  const text = canonicalizeForRouting(question);
  const match = text.match(/\b(top|bottom)\s*(\d{1,2})?\b/i);
  if (match) return { direction: match[1].toLowerCase(), count: Math.max(1, Math.min(Number(match[2] || 5), 20)) };
  if (/\b(most|maximum)\b/i.test(text) || /سب سے زیادہ/i.test(text)) return { direction: "top", count: 5 };
  if (/سب سے کم/i.test(text)) return { direction: "bottom", count: 5 };
  return null;
}

function analysisThinkLevelForQuestion(question) {
  const text = canonicalizeForRouting(question);
  const hardest = /\b(deep|detailed|why|reason|root cause|forecast|prediction|predict|strategy|strategic|risk|anomaly|trend|management|recommend|suggest|compare|comparison|growth|decline|improve|optimization|optimise|optimize|kyun|wajah|tafseel|analysis|analyze)\b/i.test(text)
    || /(کیوں|وجہ|تجزیہ|پیش گوئی|اندازہ|حکمت عملی|خطرہ|موازنہ|بہتری)/i.test(String(question || ""));
  if (hardest) return aiConfig.ollamaMaxThinking ? "max" : aiConfig.ollamaComplexThinkLevel;
  return aiConfig.ollamaPlannerThinkLevel;
}

function wantsComparison(question) {
  const routed = canonicalizeForRouting(question);
  return /\b(compare|comparison|versus|\bvs\b|growth|grow|change|difference|kal se|previous period|pichl[aei].*muqabla)\b/i.test(routed)
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
  const text = canonicalizeForRouting(question);
  return /\b(qty|quantity|quantities|piece|pieces|pcs|unit|units|kitne\s*(?:piece|pcs|unit)|kitni\s*quantity)\b/i.test(text)
    || /(مقدار|تعداد|پیِس|پیس|یونٹ)/i.test(text);
}

function isAmountQuestion(question) {
  const text = canonicalizeForRouting(question);
  return /\b(amount|value|revenue|net sales?|sales? amount|rupees?|rs\.?|pkr|kitni sale|kitna sale|kitni bikri|kitna revenue)\b/i.test(text)
    || /(رقم|مالیت|نیٹ\s*سیلز|سیلز\s*رقم|کتنی\s*فروخت|کتنی\s*سیل)/i.test(text);
}

function requestedKpis(report, question) {
  const q = canonicalizeForRouting(question);
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
  if (/\b(purchase value|purchase valuation|stock.*purchase price)\b/i.test(q) || /(خریداری.*ویلیو|خرید.*مالیت)/i.test(q)) add(/purchase price|purchase value/i);
  if (/\b(discount value|discounted value)\b/i.test(q) || /ڈسکاؤنٹ.*ویلیو/i.test(q)) add(/discount price|discount value/i);
  if (/\b(retail value|selling value|potential retail)\b/i.test(q) || /ریٹیل.*ویلیو/i.test(q)) add(/retail value/i);
  if (/\b(stock value|inventory value|cost value|at cost|اسٹاک.*ویلیو)\b/i.test(q)) add(/value at cost|cost value|stock value at cost/i);
  if (/\b(return|returns|refund|wapsi|wapas)\b/i.test(q) || /(واپسی|ریٹرن)/i.test(q)) {
    if (quantity) add(/return quantity/i);
    else add(/return amount/i);
  }
  if (/\b(sent|bhej|بھیج)\b/i.test(q)) add(/sent/i);
  if (/\b(received|receive|mila|موصول)\b/i.test(q)) add(/received/i);
  if (/\b(in transit|pending transfer|راستے|زیرِ ترسیل)\b/i.test(q)) add(/transit|pending/i);
  if (/\bcash\b/i.test(q) || /کیش/i.test(q)) add(/^cash$/i);
  if (/\bcard\b/i.test(q) || /کارڈ/i.test(q)) add(/^card$/i);
  if (/\bcredit\b/i.test(q) || /کریڈٹ/i.test(q)) add(/^credit$/i);
  if (/\bother payment|other tender\b/i.test(q)) add(/^other$/i);
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
  const insight = deterministicInsight(currentReport, question, language);
  const action = deterministicAction(currentReport, question, language);
  return {
    summary: lines.join("\n"),
    keyPoints: [insight].filter(Boolean),
    actions: [action].filter(Boolean),
  };
}

function requestedRowMetrics(question, row) {
  const q = canonicalizeForRouting(question);
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
  const routed = canonicalizeForRouting(question);
  return /\b(branch wise|outlet wise|shop wise|dukaan wise|store wise|godown wise|stockroom wise|product wise|item wise|barcode wise|design wise|brand wise|category wise|catagory wise|supplier wise|vendor wise|which supplier|which vendor|salesman wise|day wise|daily|ranking|breakdown|top|bottom|best|worst|highest|lowest)\b/i.test(routed)
    || /(برانچ وائز|اسٹور وائز|گودام وائز|پروڈکٹ وائز|آئٹم وائز|بارکوڈ وائز|ڈیزائن وائز|برانڈ وائز|کیٹیگری وائز|سیلز مین وائز|روزانہ|تفصیل|سب سے زیادہ|سب سے کم)/i.test(String(question || ""));
}

function supportingKpisForBreakdown(report, question) {
  const kpis = Array.isArray(report?.kpis) ? report.kpis.filter((kpi) => kpi && kpi.label) : [];
  const q = canonicalizeForRouting(question);
  const title = String(report?.title || "").toLowerCase();
  const onlyQuantity = isQuantityQuestion(q) && !isAmountQuestion(q) && !/profit|margin|discount|value|payment/i.test(q);
  const onlyProfit = /\b(profit|margin|munafa|kamai)\b/i.test(q) || /(منافع|مارجن)/i.test(String(question || ""));
  const onlyDiscount = /\b(discount|disc|markdown)\b/i.test(q) || /ڈسکاؤنٹ/i.test(String(question || ""));
  const onlyValue = /\b(stock value|inventory value|valuation|retail value|purchase value|cost value|discount value)\b/i.test(q);
  let selected = [];
  const add = (predicate) => {
    for (const kpi of kpis) if (predicate(kpi) && !selected.includes(kpi)) selected.push(kpi);
  };
  if (onlyQuantity) add((kpi) => /quantity|qty|stock|pieces|units/i.test(kpi.label));
  else if (onlyProfit) {
    add((kpi) => /profit|margin/i.test(kpi.label));
    add((kpi) => /net sales|sales amount/i.test(kpi.label));
  } else if (onlyDiscount) {
    add((kpi) => /discount/i.test(kpi.label));
    add((kpi) => /net sales|sales amount/i.test(kpi.label));
  } else if (onlyValue) add((kpi) => /value|valuation/i.test(kpi.label));
  else if (/sales summary|sales$/i.test(title) || /^sales summary$/i.test(title)) {
    add((kpi) => /sale amount|return amount|net sales|sale quantity|return quantity|net quantity|gross profit|margin|discount|bills/i.test(kpi.label));
  } else if (/purchase/i.test(title)) {
    add((kpi) => /purchase.*amount|purchase.*quantity|products/i.test(kpi.label));
  } else if (/supplier payment/i.test(title)) {
    add((kpi) => /supplier payment|suppliers paid|top supplier/i.test(kpi.label));
  } else if (/payment mix/i.test(title)) {
    add((kpi) => /^(cash|card|credit|other|total paid)$/i.test(kpi.label));
  } else if (/transfer/i.test(title)) {
    add((kpi) => /sent|received|transit|pending/i.test(kpi.label));
  } else if (/stock|inventory/i.test(title)) {
    add((kpi) => /current stock|quantity|value/i.test(kpi.label));
  }
  if (!selected.length) selected = requestedKpis(report, question);
  if (!selected.length) selected = kpis.slice(0, 6);
  return selected.slice(0, 8);
}

function scopeBreakdownText(report, language) {
  const f = report?.filters || {};
  const parts = [friendlyPeriod(f, language)];
  const add = (label, values) => { if (Array.isArray(values) && values.length) parts.push(`${label}: ${values.slice(0, 6).join(", ")}${values.length > 6 ? "…" : ""}`); };
  add(language === "urdu" ? "برانچ" : "Branch", f.branches);
  add(language === "urdu" ? "اسٹور" : "Store", f.stores);
  add(language === "urdu" ? "اکاؤنٹ" : "Account", f.accounts);
  add(language === "urdu" ? "بارکوڈ" : "Barcode", f.barcodes);
  return parts.join(" · ");
}

function deterministicInsight(report, question, language) {
  const rows = Array.isArray(report?.rows) ? report.rows.filter((row) => row && row.Label != null) : [];
  if (rows.length >= 2) {
    const metricKey = rows[0].Amount != null ? "Amount" : rows[0].Quantity != null ? "Quantity" : rows[0].SentQuantity != null ? "SentQuantity" : null;
    if (metricKey) {
      const ordered = [...rows].sort((a,b) => Number(b?.[metricKey] || 0) - Number(a?.[metricKey] || 0));
      const top = ordered[0], second = ordered[1];
      const total = ordered.reduce((sum,row) => sum + Math.max(0, Number(row?.[metricKey] || 0)), 0);
      const share = total > 0 ? Number(top?.[metricKey] || 0) * 100 / total : 0;
      const format = metricKey === "Amount" ? "currency" : "number";
      return localizedText(language, {
        english: `${String(top.Label)} is the strongest row at ${formatNumberValue(top[metricKey], format)}${total > 0 ? ` (${share.toLocaleString("en-PK", { maximumFractionDigits:1 })}% of shown total)` : ""}. Next is ${String(second.Label)} at ${formatNumberValue(second[metricKey], format)}.`,
        roman: `${String(top.Label)} sab se strong row hai: ${formatNumberValue(top[metricKey], format)}${total > 0 ? `, shown total ka ${share.toLocaleString("en-PK", { maximumFractionDigits:1 })}%` : ""}. Next ${String(second.Label)} hai: ${formatNumberValue(second[metricKey], format)}.`,
        urdu: `${String(top.Label)} سب سے مضبوط قطار ہے: ${formatNumberValue(top[metricKey], format)}${total > 0 ? `، دکھائے گئے کل کا ${share.toLocaleString("en-PK", { maximumFractionDigits:1 })}%` : ""}۔ اگلی ${String(second.Label)} ہے: ${formatNumberValue(second[metricKey], format)}۔`,
      });
    }
  }
  const kpis = supportingKpisForBreakdown(report, question);
  if (kpis.length >= 2) {
    return localizedText(language, {
      english: `The live result is internally consistent across ${kpis.length} supporting measures shown in the breakdown.`,
      roman: `Live result ko ${kpis.length} supporting measures ke breakdown se cross-check kiya gaya hai.`,
      urdu: `لائیو نتیجے کو بریک ڈاؤن میں دکھائے گئے ${kpis.length} معاون پیمانوں سے کراس چیک کیا گیا ہے۔`,
    });
  }
  return "";
}

function deterministicAction(report, question, language) {
  const title = String(report?.title || "").toLowerCase();
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  if (/supplier payment/.test(title)) return localizedText(language, { english:"Review the top-paid suppliers against purchase volume and outstanding payable before the next payment cycle.", roman:"Next payment cycle se pehle top-paid suppliers ko purchase volume aur outstanding payable ke against review karein.", urdu:"اگلی ادائیگی سے پہلے زیادہ ادائیگی والے سپلائرز کو خریداری اور بقایا ادائیگی کے مقابلے میں دیکھیں۔" });
  if (/payment mix/.test(title)) return localizedText(language, { english:"Review the tender mix for unusual cash/card/credit concentration and reconcile it with the same period's bills.", roman:"Cash/card/credit mix mein unusual concentration review karein aur same period ke bills ke saath reconcile karein.", urdu:"کیش/کارڈ/کریڈٹ مکس میں غیر معمولی تناسب دیکھیں اور اسی مدت کے بلز کے ساتھ ریکنسائل کریں۔" });
  if (/fbr|gst/.test(title)) return localizedText(language, { english:"Review any non-FBR-invoiced sales and GST/taxable-value gaps before compliance reconciliation.", roman:"Compliance reconciliation se pehle non-FBR-invoiced sales aur GST/taxable-value gaps review karein.", urdu:"کمپلائنس ریکنسلی ایشن سے پہلے بغیر FBR انوائس والی سیلز اور GST/ٹیکسیبل ویلیو کے فرق دیکھیں۔" });
  if (/discount polic/.test(title)) return localizedText(language, { english:"Review the highest active discount percentages and their validity/branch scope before promotion decisions.", roman:"Promotion decision se pehle highest active discount percentages aur unki validity/branch scope review karein.", urdu:"پروموشن فیصلے سے پہلے زیادہ فعال ڈسکاؤنٹ فیصد اور ان کی مدت/برانچ دائرہ دیکھیں۔" });
  if (/product master/.test(title)) return localizedText(language, { english:"Use the product breakdown to verify assortment coverage and drill into missing/duplicate attributes where needed.", roman:"Product breakdown se assortment coverage verify karein aur zarurat par missing/duplicate attributes drill-down karein.", urdu:"پروڈکٹ بریک ڈاؤن سے اسورٹمنٹ کوریج چیک کریں اور ضرورت پر غائب/ڈپلیکیٹ خصوصیات دیکھیں۔" });
  if (/transfer/.test(title) && rows.some((r)=>Number(r.PendingQuantity||0)>0)) return localizedText(language, { english:"Prioritize routes with the highest in-transit quantity and confirm receipt status.", roman:"Jin transfer routes mein in-transit quantity zyada hai unki receipt status pehle verify karein.", urdu:"جن ٹرانسفر روٹس میں راستے کی مقدار زیادہ ہے ان کی وصولی پہلے چیک کریں۔" });
  if (/stock|inventory/.test(title)) return localizedText(language, { english:"Review the highest-stock and negative/slow-moving positions before the next replenishment decision.", roman:"Next replenishment se pehle highest stock aur negative/slow-moving positions review karein.", urdu:"اگلی ری پلینشمنٹ سے پہلے زیادہ اسٹاک اور منفی/سست رفتار پوزیشنز دیکھیں۔" });
  if (/purchase/.test(title)) return localizedText(language, { english:"Compare the largest purchase contributors with their sell-through before placing the next order.", roman:"Next order se pehle largest purchase contributors ka sell-through compare karein.", urdu:"اگلے آرڈر سے پہلے بڑی خریداری والے آئٹمز/سپلائرز کا سیل تھرو دیکھیں۔" });
  if (/sales/.test(title)) return localizedText(language, { english:"Use the strongest and weakest breakdown rows to decide where stock, staff attention, or promotion should be adjusted.", roman:"Strongest aur weakest breakdown rows dekh kar stock, staff attention ya promotion adjust karein.", urdu:"مضبوط اور کمزور بریک ڈاؤن قطاروں کی بنیاد پر اسٹاک، اسٹاف توجہ یا پروموشن ایڈجسٹ کریں۔" });
  return localizedText(language, { english:"Review the leading and weakest rows before taking the next operational action.", roman:"Next operational action se pehle leading aur weakest rows review karein.", urdu:"اگلے آپریشنل ایکشن سے پہلے مضبوط اور کمزور قطاریں دیکھیں۔" });
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
      return { summary, keyPoints: [deterministicInsight(report, question, language)].filter(Boolean), actions: [deterministicAction(report, question, language)].filter(Boolean) };
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
    return { summary, keyPoints: [deterministicInsight(report, question, language)].filter(Boolean), actions: [deterministicAction(report, question, language)].filter(Boolean) };
  }

  const selectedKpis = requestedKpis(report, question);
  const factText = selectedKpis.map((kpi) => `${localizedKpiLabel(kpi.label, language)}: ${formatKpiValue(kpi)}`);
  if (!factText.length) {
    return { summary: localizedText(language, { english: `${period}: matching live result found.`, roman: `${period}: matching live result mil gaya.`, urdu: `${period}: متعلقہ لائیو نتیجہ مل گیا۔` }), keyPoints: [deterministicInsight(report, question, language)].filter(Boolean), actions: [deterministicAction(report, question, language)].filter(Boolean) };
  }
  const summary = language === "urdu"
    ? `${period} — ${factText.join(" | ")}۔`
    : language === "roman"
      ? `${period} — ${factText.join(" | ")}.`
      : `${period} — ${factText.join(" | ")}.`;
  const breakdownKpis = supportingKpisForBreakdown(report, question);
  const breakdown = breakdownKpis.map((kpi) => `${localizedKpiLabel(kpi.label, language)}: ${formatKpiValue(kpi)}`);
  return {
    summary,
    keyPoints: [...breakdown, deterministicInsight(report, question, language)].filter(Boolean).slice(0, 9),
    actions: [deterministicAction(report, question, language)].filter(Boolean),
  };
}

function assistantAnswerFromReport(report, narrative, question, language = "english") {
  const chart = report.charts?.[0] || null;
  const metrics = supportingKpisForBreakdown(report, question).map((kpi) => ({
    key: String(kpi.key || kpi.label || "metric"),
    label: localizedKpiLabel(kpi.label, language),
    format: kpi.format || "number",
    value: Number(kpi.value || 0),
  }));
  return {
    mode: "report",
    answer: narrative.summary,
    keyPoints: narrative.keyPoints || [],
    actions: narrative.actions || [],
    metrics,
    scope: scopeBreakdownText(report, language),
    report,
    visualization: shouldShowAssistantVisualization(question, chart) ? chart : null,
    warning: narrative.warning || null,
  };
}


function businessAnalysisIntent(question) {
  const text = canonicalizeForRouting(question);
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
          trainingExamples: getQuestionBankTrainingPrompt(question, 5),
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
      // GPT-OSS supports low/medium/high reasoning effort. Use higher effort
      // only for genuinely analytical/forecast/why questions so normal
      // management answers stay fast and starter usage lasts longer.
      think: analysisThinkLevelForQuestion(question),
    });
    return {
      summary: answer,
      keyPoints: fallback.keyPoints || [],
      actions: fallback.actions || [],
      warning: null,
    };
  } catch (error) {
    return {
      ...fallback,
      warning: `Deep AI analysis was unavailable, so a verified live-data analysis was returned instead: ${error.message}`,
    };
  }
}

function forecastIntent(question) {
  const text = canonicalizeForRouting(question);
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
  if (/\b(sale|sales|revenue|bikri|farokht)\b/i.test(text) || /(سیلز|فروخت|ریونیو)/i.test(text)) return "sales";
  // Profit, supplier, transfer, discount, target and other forward-looking
  // questions need a different model/SQL interpretation; do not silently turn
  // them into a sales forecast. They fall through to the grounded planner.
  if (/\b(profit|margin|supplier|vendor|transfer|discount|target|incentive|purchase|price|gmroi|roi)\b/i.test(text)) return "complex";
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
  const routedCombined = canonicalizeForRouting(combined);
  const hasHistory = Array.isArray(history) && history.some((item) => item?.role === "user" && String(item.content || "").trim());
  const intent = forecastIntent(combined);
  const subject = /\b(sale|sales|revenue|bikri|farokht|purchase|kharid|khareed|stock|inventory|demand|payment|profit|margin|return|transfer|branch|product|barcode|design|salesman)\b/i.test(routedCombined)
    || /(سیلز|فروخت|خریداری|اسٹاک|طلب|ادائیگی|منافع|واپسی|ٹرانسفر|برانچ|پروڈکٹ|بارکوڈ|ڈیزائن)/i.test(combined);

  const asksStockValue = /\b(stock|inventory)\b.*\b(value|valuation|worth)\b|\b(value|valuation|worth)\b.*\b(stock|inventory)\b/i.test(routedCombined)
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
      keyPoints: [localizedText(language, {
        english: `Matching active sales days found: ${activeDays} of the last 56 days.`,
        roman: `Pichlay 56 din mein matching active sales days: ${activeDays}.`,
        urdu: `پچھلے 56 دن میں متعلقہ فعال سیلز دن: ${activeDays}۔`,
      })],
      actions: [localizedText(language, {
        english: "Widen the branch/product scope or choose a scope with at least 7 active sales days before relying on a forecast.",
        roman: "Forecast par rely karne se pehle branch/product scope widen karein ya kam az kam 7 active sales days wala scope use karein.",
        urdu: "پیش گوئی پر انحصار سے پہلے برانچ/پروڈکٹ کا دائرہ وسیع کریں یا کم از کم 7 فعال سیلز دن والا دائرہ استعمال کریں۔",
      })],
      metrics: [{ key: "activeDays", label: language === "urdu" ? "فعال تاریخی دن" : "Active history days", format: "number", value: activeDays }],
      scope: `${window.fromDate} to ${window.toDate}`,
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
  const recentTrendPct = (trendMultiplier - 1) * 100;
  const avgForecastPerDay = metricValue / Math.max(1, predictions.length);
  const metricFormat = targetKey === "Quantity" ? "number" : "currency";
  return {
    mode: "forecast",
    answer,
    keyPoints: [
      localizedText(language, {
        english: `Forecast total: ${formatNumberValue(metricValue, metricFormat)} across ${predictions.length} day(s).`,
        roman: `Forecast total: ${formatNumberValue(metricValue, metricFormat)}, ${predictions.length} din ke liye.`,
        urdu: `پیش گوئی کا کل: ${formatNumberValue(metricValue, metricFormat)}، ${predictions.length} دن کے لیے۔`,
      }),
      localizedText(language, {
        english: `Average forecast per day: ${formatNumberValue(avgForecastPerDay, metricFormat)}.`,
        roman: `Average forecast per day: ${formatNumberValue(avgForecastPerDay, metricFormat)}.`,
        urdu: `روزانہ اوسط پیش گوئی: ${formatNumberValue(avgForecastPerDay, metricFormat)}۔`,
      }),
      localizedText(language, {
        english: `Recent trend adjustment: ${recentTrendPct >= 0 ? "+" : ""}${recentTrendPct.toLocaleString("en-PK", { maximumFractionDigits: 1 })}%.`,
        roman: `Recent trend adjustment: ${recentTrendPct >= 0 ? "+" : ""}${recentTrendPct.toLocaleString("en-PK", { maximumFractionDigits: 1 })}%.`,
        urdu: `حالیہ رجحان ایڈجسٹمنٹ: ${recentTrendPct >= 0 ? "+" : ""}${recentTrendPct.toLocaleString("en-PK", { maximumFractionDigits: 1 })}%۔`,
      }),
      localizedText(language, {
        english: `History basis: ${activeDays} active sales day(s) within the last 56 days.`,
        roman: `History basis: pichlay 56 din mein ${activeDays} active sales days.`,
        urdu: `تاریخی بنیاد: پچھلے 56 دن میں ${activeDays} فعال سیلز دن۔`,
      }),
    ],
    actions: [localizedText(language, {
      english: confidence === "Low" ? "Treat this as a planning range and review again after more live sales accumulate." : "Use this forecast for near-term planning, but re-check it as fresh live sales arrive.",
      roman: confidence === "Low" ? "Is forecast ko planning range samjhein aur zyada live sales aane ke baad dobara review karein." : "Near-term planning ke liye use karein, lekin fresh live sales aate hi dobara check karein.",
      urdu: confidence === "Low" ? "اس پیش گوئی کو منصوبہ بندی کی حد سمجھیں اور مزید لائیو سیلز آنے کے بعد دوبارہ جائزہ لیں۔" : "قریب مدتی منصوبہ بندی کے لیے استعمال کریں، مگر نئی لائیو سیلز آنے پر دوبارہ چیک کریں۔",
    })],
    metrics: [
      { key: "forecastTotal", label: targetKey === "Quantity" ? (language === "urdu" ? "متوقع مقدار" : "Forecast Quantity") : (language === "urdu" ? "متوقع سیلز" : "Forecast Sales"), format: metricFormat, value: metricValue },
      { key: "forecastDailyAverage", label: language === "urdu" ? "روزانہ اوسط" : "Daily Average", format: metricFormat, value: avgForecastPerDay },
      { key: "historyActiveDays", label: language === "urdu" ? "فعال تاریخی دن" : "Active History Days", format: "number", value: activeDays },
      { key: "trendAdjustment", label: language === "urdu" ? "رجحان ایڈجسٹمنٹ" : "Trend Adjustment", format: "percent", value: recentTrendPct },
    ],
    scope: `${window.fromDate} to ${window.toDate}`,
    rows: predictions,
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
    return {
      mode: "forecast", answer,
      keyPoints: [
        localizedText(language, { english:`Current stock: ${formatNumberValue(currentStock)} units.`, roman:`Current stock: ${formatNumberValue(currentStock)} units.`, urdu:`موجودہ اسٹاک: ${formatNumberValue(currentStock)} یونٹس۔` }),
        localizedText(language, { english:`Predicted demand: ${formatNumberValue(totalDemand)} units.`, roman:`Predicted demand: ${formatNumberValue(totalDemand)} units.`, urdu:`متوقع طلب: ${formatNumberValue(totalDemand)} یونٹس۔` }),
        localizedText(language, { english:`Projected closing stock: ${formatNumberValue(projectedClosing)} units.`, roman:`Projected closing stock: ${formatNumberValue(projectedClosing)} units.`, urdu:`متوقع اختتامی اسٹاک: ${formatNumberValue(projectedClosing)} یونٹس۔` }),
      ],
      actions: [localizedText(language, { english: projectedClosing < 0 ? "Plan replenishment before the forecast horizon ends." : "Monitor actual demand against forecast and adjust replenishment only if the gap becomes material.", roman: projectedClosing < 0 ? "Forecast horizon khatam hone se pehle replenishment plan karein." : "Actual demand ko forecast ke against monitor karein aur material gap par replenishment adjust karein.", urdu: projectedClosing < 0 ? "پیش گوئی کی مدت ختم ہونے سے پہلے ری پلینشمنٹ پلان کریں۔" : "اصل طلب کو پیش گوئی کے مقابلے میں مانیٹر کریں اور نمایاں فرق پر ری پلینشمنٹ ایڈجسٹ کریں۔" })],
      metrics: [
        { key:"currentStock", label:language === "urdu" ? "موجودہ اسٹاک" : "Current Stock", format:"number", value:currentStock },
        { key:"predictedDemand", label:language === "urdu" ? "متوقع طلب" : "Predicted Demand", format:"number", value:totalDemand },
        { key:"projectedClosingStock", label:language === "urdu" ? "متوقع اختتامی اسٹاک" : "Projected Closing Stock", format:"number", value:projectedClosing },
      ],
      scope:`${demandWindow.fromDate} to ${demandWindow.toDate}`, rows:demand.rows, visualization:demand.visualization,
      prediction:{ type:"stock", confidence, currentStock, predictedDemand:totalDemand, projectedClosingStock:projectedClosing, horizon:demandWindow }
    };
  }

  if (intent === "stockout") {
    if (currentStock <= 0) {
      const answer = localizedText(language, {
        english: `AI Stockout Prediction: current stock is ${formatNumberValue(currentStock)}; this scope is already at or below zero stock.`,
        roman: `AI Stockout Prediction: current stock ${formatNumberValue(currentStock)} hai; ye scope already zero ya negative stock par hai.`,
        urdu: `AI اسٹاک آؤٹ پیش گوئی: موجودہ اسٹاک ${formatNumberValue(currentStock)} ہے؛ یہ دائرہ پہلے ہی صفر یا منفی اسٹاک پر ہے۔`,
      });
      return { mode:"forecast", answer, keyPoints:[localizedText(language,{english:"This scope is already at or below zero stock.",roman:"Ye scope already zero ya negative stock par hai.",urdu:"یہ دائرہ پہلے ہی صفر یا منفی اسٹاک پر ہے۔"})], actions:[localizedText(language,{english:"Verify the live stock position and replenish/adjust the affected barcode or scope immediately.",roman:"Live stock position verify karke affected barcode/scope ko foran replenish ya adjust karein.",urdu:"لائیو اسٹاک پوزیشن چیک کر کے متاثرہ بارکوڈ/دائرہ فوراً ری پلینش یا ایڈجسٹ کریں۔"})], metrics:[{key:"currentStock",label:language === "urdu" ? "موجودہ اسٹاک" : "Current Stock",format:"number",value:currentStock},{key:"daysCover",label:language === "urdu" ? "دنوں کا کور" : "Days Cover",format:"number",value:0}], rows:[], visualization:null, prediction:{ type:"stockout", confidence, currentStock, daysCover:0 } };
    }
    if (avgDailyDemand <= 0) {
      return { mode: "forecast", answer: localizedText(language, {
        english: "AI Stockout Prediction: recent matching demand is zero/negative, so a meaningful stockout date cannot be estimated.",
        roman: "AI Stockout Prediction: recent matching demand zero/negative hai, is liye meaningful stockout date estimate nahi ho sakti.",
        urdu: "AI اسٹاک آؤٹ پیش گوئی: حالیہ متعلقہ طلب صفر یا منفی ہے، اس لیے قابلِ معنی اسٹاک آؤٹ تاریخ کا اندازہ نہیں لگایا جا سکتا۔",
      }), keyPoints:[localizedText(language,{english:`Current stock: ${formatNumberValue(currentStock)} units.`,roman:`Current stock: ${formatNumberValue(currentStock)} units.`,urdu:`موجودہ اسٹاک: ${formatNumberValue(currentStock)} یونٹس۔`})], actions:[localizedText(language,{english:"Use a wider demand history before estimating a stockout date.",roman:"Stockout date estimate karne se pehle demand history widen karein.",urdu:"اسٹاک آؤٹ تاریخ کے اندازے سے پہلے طلب کی تاریخ وسیع کریں۔"})], metrics:[{key:"currentStock",label:language === "urdu" ? "موجودہ اسٹاک" : "Current Stock",format:"number",value:currentStock}], rows:[], visualization:null, prediction:{ type:"stockout", confidence:"Low", currentStock } };
    }
    const daysCover = currentStock / avgDailyDemand;
    const date = new Date(`${todayText}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + Math.max(1, Math.ceil(daysCover)));
    const stockoutDate = date.toISOString().slice(0, 10);
    const answer = language === "urdu"
      ? `AI اسٹاک آؤٹ پیش گوئی: موجودہ اسٹاک ${formatNumberValue(currentStock)} ہے اور حالیہ طلب کے مطابق تقریباً ${formatNumberValue(daysCover)} دن کا کور بنتا ہے۔ متوقع اسٹاک آؤٹ تاریخ ${stockoutDate} ہے۔ اعتماد: ${confidence === "High" ? "زیادہ" : confidence === "Medium" ? "درمیانہ" : "کم"}۔`
      : language === "roman"
        ? `AI Stockout Prediction: current stock ${formatNumberValue(currentStock)} hai aur recent demand ke hisab se taqreeban ${formatNumberValue(daysCover)} din ka cover hai. Predicted stockout date ${stockoutDate} hai. Confidence: ${confidence}.`
        : `AI Stockout Prediction: current stock is ${formatNumberValue(currentStock)}, giving about ${formatNumberValue(daysCover)} days of cover at recent demand. Predicted stockout date: ${stockoutDate}. Confidence: ${confidence}.`;
    return {
      mode:"forecast", answer,
      keyPoints:[
        localizedText(language,{english:`Current stock: ${formatNumberValue(currentStock)} units.`,roman:`Current stock: ${formatNumberValue(currentStock)} units.`,urdu:`موجودہ اسٹاک: ${formatNumberValue(currentStock)} یونٹس۔`}),
        localizedText(language,{english:`Average predicted daily demand: ${formatNumberValue(avgDailyDemand)} units.`,roman:`Average predicted daily demand: ${formatNumberValue(avgDailyDemand)} units.`,urdu:`متوقع روزانہ اوسط طلب: ${formatNumberValue(avgDailyDemand)} یونٹس۔`}),
        localizedText(language,{english:`Estimated cover: ${formatNumberValue(daysCover)} days; predicted stockout date: ${stockoutDate}.`,roman:`Estimated cover: ${formatNumberValue(daysCover)} days; predicted stockout date: ${stockoutDate}.`,urdu:`متوقع کور: ${formatNumberValue(daysCover)} دن؛ متوقع اسٹاک آؤٹ تاریخ: ${stockoutDate}۔`}),
      ],
      actions:[localizedText(language,{english:"Plan replenishment before the predicted stockout date and re-check after each major sales day.",roman:"Predicted stockout date se pehle replenishment plan karein aur har major sales day ke baad dobara check karein.",urdu:"متوقع اسٹاک آؤٹ تاریخ سے پہلے ری پلینشمنٹ پلان کریں اور ہر بڑے سیلز دن کے بعد دوبارہ چیک کریں۔"})],
      metrics:[
        {key:"currentStock",label:language === "urdu" ? "موجودہ اسٹاک" : "Current Stock",format:"number",value:currentStock},
        {key:"averageDailyDemand",label:language === "urdu" ? "روزانہ اوسط طلب" : "Avg Daily Demand",format:"number",value:avgDailyDemand},
        {key:"daysCover",label:language === "urdu" ? "دنوں کا کور" : "Days Cover",format:"number",value:daysCover},
      ],
      rows:demand.rows, visualization:null, prediction:{ type:"stockout", confidence, currentStock, averageDailyDemand:avgDailyDemand, daysCover, stockoutDate }
    };
  }

  const required = Math.max(0, totalDemand - currentStock);
  const answer = language === "urdu"
    ? `AI ری آرڈر اندازہ (${demandWindow.fromDate} سے ${demandWindow.toDate}): تجویز کردہ اضافی مقدار ${formatNumberValue(required)} یونٹس ہے۔ حساب متوقع طلب ${formatNumberValue(totalDemand)} منفی موجودہ اسٹاک ${formatNumberValue(currentStock)} پر مبنی ہے۔ اعتماد: ${confidence === "High" ? "زیادہ" : confidence === "Medium" ? "درمیانہ" : "کم"}۔`
    : language === "roman"
      ? `AI Reorder Estimate (${demandWindow.fromDate} to ${demandWindow.toDate}): suggested additional quantity ${formatNumberValue(required)} units hai. Calculation predicted demand ${formatNumberValue(totalDemand)} minus current stock ${formatNumberValue(currentStock)} par based hai. Confidence: ${confidence}.`
      : `AI Reorder Estimate (${demandWindow.fromDate} to ${demandWindow.toDate}): suggested additional quantity is ${formatNumberValue(required)} units, based on predicted demand ${formatNumberValue(totalDemand)} minus current stock ${formatNumberValue(currentStock)}. Confidence: ${confidence}.`;
  return {
    mode:"forecast", answer,
    keyPoints:[
      localizedText(language,{english:`Current stock: ${formatNumberValue(currentStock)} units.`,roman:`Current stock: ${formatNumberValue(currentStock)} units.`,urdu:`موجودہ اسٹاک: ${formatNumberValue(currentStock)} یونٹس۔`}),
      localizedText(language,{english:`Predicted demand: ${formatNumberValue(totalDemand)} units.`,roman:`Predicted demand: ${formatNumberValue(totalDemand)} units.`,urdu:`متوقع طلب: ${formatNumberValue(totalDemand)} یونٹس۔`}),
      localizedText(language,{english:`Suggested additional reorder: ${formatNumberValue(required)} units.`,roman:`Suggested additional reorder: ${formatNumberValue(required)} units.`,urdu:`تجویز کردہ اضافی ری آرڈر: ${formatNumberValue(required)} یونٹس۔`}),
    ],
    actions:[localizedText(language,{english:required > 0 ? "Place/plan the reorder against the forecast horizon, then refresh after fresh sales or receipts." : "No additional reorder is indicated by this forecast; continue monitoring live demand.",roman:required > 0 ? "Forecast horizon ke against reorder plan karein, phir fresh sales/receipts ke baad refresh karein." : "Is forecast ke mutabiq additional reorder indicated nahi; live demand monitor karte rahain.",urdu:required > 0 ? "پیش گوئی کی مدت کے مطابق ری آرڈر پلان کریں، پھر نئی سیلز/رسید کے بعد دوبارہ چیک کریں۔" : "اس پیش گوئی کے مطابق اضافی ری آرڈر درکار نہیں؛ لائیو طلب مانیٹر کرتے رہیں۔"})],
    metrics:[
      {key:"currentStock",label:language === "urdu" ? "موجودہ اسٹاک" : "Current Stock",format:"number",value:currentStock},
      {key:"predictedDemand",label:language === "urdu" ? "متوقع طلب" : "Predicted Demand",format:"number",value:totalDemand},
      {key:"suggestedQuantity",label:language === "urdu" ? "تجویز کردہ ری آرڈر" : "Suggested Reorder",format:"number",value:required},
    ],
    scope:`${demandWindow.fromDate} to ${demandWindow.toDate}`, rows:demand.rows, visualization:demand.visualization, prediction:{ type:"reorder", confidence, currentStock, predictedDemand:totalDemand, suggestedQuantity:required, horizon:demandWindow }
  };
}

async function getSchema(tenantId, pool, requestedTables, question = "") {
  // The 10k corpus teaches language/intent only. Schema is always read from the
  // CURRENT authenticated tenant so the same Assistant works across every DB
  // that shares the Cherry schema, without learning tenant-specific names/data.
  try {
    const catalog = await getDatabaseCatalog(tenantId);
    const text = canonicalizeForRouting(question);
    const financeTables = /\b(supplier|vendor|payment|paid|pay|ledger|account|cash book|bank book|voucher|expense|payable|receivable)\b/i.test(text)
      ? ["CBook", "BBook", "Chart", "BillAdjust", "PaymentRegister"]
      : [];
    const preferred = [...new Set([...financeTables, ...(requestedTables || [])])]
      .filter((name) => catalog.tables.some((table) => String(table.name).toLowerCase() === String(name).toLowerCase()));
    let schemaText = "";
    let selected = [];
    if (preferred.length) {
      schemaText = compactSchema(catalog, preferred, "", Math.min(40, preferred.length + 12));
      const lower = new Set(preferred.map((x) => String(x).toLowerCase()));
      selected = catalog.tables.filter((table) => lower.has(String(table.name).toLowerCase())).map((table) => table.name);
    } else {
      schemaText = compactSchema(catalog, [], question, 24);
      const names = new Set();
      for (const line of schemaText.split("\n")) {
        const match = line.match(/^\w+\.([A-Za-z_][\w$]*)\s+\[/);
        if (match) names.add(match[1]);
      }
      selected = [...names];
    }
    return { tables: selected, schemaText, source: "current-tenant-live-catalog" };
  } catch (error) {
    console.warn("[AI Assistant] Live tenant catalog unavailable, using trained-table fallback:", error.message);
    const safe = (requestedTables || []).filter((name) => allowedTables.includes(name));
    if (!safe.length) return { tables: [], schemaText: "", source: "fallback" };
    const request = pool.request();
    const params = safe.map((name, index) => { request.input(`table${index}`, sql.NVarChar(128), name); return `@table${index}`; });
    const result = await request.query(`SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN (${params.join(",")}) ORDER BY TABLE_NAME,ORDINAL_POSITION`);
    const grouped = {};
    for (const row of result.recordset || []) (grouped[row.TABLE_NAME] ||= []).push(`${row.COLUMN_NAME}:${row.DATA_TYPE}`);
    return { tables:Object.keys(grouped), schemaText:Object.entries(grouped).map(([name,columns])=>`${name}(${columns.join(", ")})`).join("\n"), source:"trained-table-fallback" };
  }
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
      SELECT TOP 2000 ActCod code, MAX(AcName) label
      FROM Chart
      WHERE ISNULL(PartyType,'')='S' AND ISNULL(AcName,'')<>''
      GROUP BY ActCod
      ORDER BY LEN(MAX(AcName)) DESC;
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
    if (!resolved.accounts?.length && conceptsForText(question).has("supplier")) {
      const supplier = (result.recordsets?.[2] || []).find((row) => phraseAppears(question, row.label) || phraseAppears(question, row.code));
      if (supplier) resolved.accounts = [String(supplier.code)];
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

async function plannerFallback({ tenantId, pool, user, message, history, memory = null, filters, language = "english", trainingUnderstanding = null }) {
  const training = trainingUnderstanding || resolveTrainingIntent(message);
  const semantic = resolveSemanticTrainingIntent(message, 12);
  const relevant = selectRelevantTables(message);
  const schema = await getSchema(tenantId, pool, relevant, message);
  const memoryContext = memory ? JSON.stringify({
    anchorQuestion: memory.anchorQuestion,
    resolvedQuestion: memory.resolvedQuestion,
    domain: memory.domain,
    dimension: memory.dimension,
    route: memory.route,
    filters: memory.filters,
    recentTurns: Array.isArray(memory.turns) ? memory.turns.slice(-6).map((turn) => ({
      question: turn.question,
      resolvedQuestion: turn.resolvedQuestion,
      answerSummary: turn.answerSummary,
      scope: turn.scope,
      route: turn.route,
    })) : [],
  }) : "none";
  const system = `You plan safe SQL Server 2014 queries for Cherry POS. Current question overrides history.
Conversation memory is CONTEXT ONLY, never a source of live numbers: ${memoryContext}
CENTRALIZED RULE: the 10,000 examples are wording/intent templates only. NEVER reuse a branch, supplier, employee, product, barcode, account name, code, amount, or other sample value from training. All entity names and all numbers must come from the CURRENT authenticated tenant live schema/data.
Return JSON only: {"mode":"sql|clarify|direct","sql":"","question":"","answer":"","interpretation":"","confidence":0.0}.
Before SQL, state one precise interpretation internally in the JSON and a confidence from 0 to 1. If confidence is below 0.82, or two materially different business interpretations are possible, use mode=clarify instead of SQL.
The 10,000-question semantic guard interpreted this turn as: ${JSON.stringify({signature:semantic.signature, confidence:semantic.confidence, route:semantic.route, intent:semantic.intent})}. Treat explicit nouns/dimensions from the CURRENT question as authoritative. If your interpretation conflicts with this grounded intent or cannot be proven from live schema, clarify instead of guessing.
Use one read-only SELECT or CTE only, no semicolon/comments, no SELECT *, and TOP ${aiConfig.maxRows} for non-aggregate detail.
When authenticated companyCode is non-blank, every CompanyCode-bearing transaction query MUST filter CompanyCode=@companyCode. Use @fromDate and @toDate for the requested period.
Detail tables are facts. For dashboard-compatible sales, combine PosDetail + UnPosDetail with UNION ALL, preserve signed returns, use detail TranDate, and do not make totals depend on BillStatus or Pos/UnPos dedupe.
Never invent a field or relation. If required logic/table is absent, clarify. Money is PKR.
For supplier/vendor payments, do NOT use POS tender tables. Use accounting ledger payment vouchers: CBook/BBook, detail BookAccount='N', /P/ voucher, non-cancelled, supplier account identified by Chart.PartyType='S', and show Chart.AcName rather than only ActCod.
Answer-scope rule: answer ONLY the metric/dimension the user asked for. Do not append Net Sales, Quantity, Bills, Discount, Profit or other KPIs unless requested or necessary for the specific reasoning question.
If the question is materially ambiguous, return mode=clarify with one focused cross-question instead of guessing.
Rules:\n${businessRules.join("\n")}\n\nNatural conversation + 10,000-question retrieval training:\n${getConversationTrainingPrompt(message)}
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
  if (planner.mode === "clarify") return { mode: "clarify", answer: String(planner.question || "Please clarify the missing business scope."), followUpOptions: [] };
  if (planner.mode === "direct") return { mode: "direct", answer: String(planner.answer || "") };
  if (planner.mode !== "sql" || !planner.sql) throw new Error("AI planner returned an invalid plan");
  const plannerConfidence = Number(planner.confidence);
  if (!Number.isFinite(plannerConfidence) || plannerConfidence < 0.82 || !String(planner.interpretation || "").trim()) {
    const clarification = trainingClarification(training, language);
    return { mode: "clarify", answer: clarification.answer, followUpOptions: clarification.options || [] };
  }
  const rows = await executePlannedSql(pool, user, filters, planner.sql, schema.tables);
  const responseLanguage = language === "urdu" ? "Urdu script" : language === "roman" ? "clear Roman Urdu" : "clear business English";
  const metricKey = rows?.[0]?.Amount != null ? "Amount" : rows?.[0]?.Quantity != null ? "Quantity" : rows?.[0]?.Value != null ? "Value" : null;
  const labelOf = (row) => String(row?.Label ?? row?.Name ?? row?.AcName ?? row?.SupplierName ?? row?.BranchName ?? row?.ProductName ?? row?.BarCode ?? row?.ActCod ?? "Row");
  const rowBreakdown = metricKey ? rows.slice(0, 8).map((row, index) => `${index + 1}) ${labelOf(row)} — ${formatNumberValue(row[metricKey], /amount|value/i.test(metricKey) ? "currency" : "number")}`) : [];
  const fallbackAnswer = rows.length
    ? localizedText(language, {
        english: rowBreakdown.length ? `Live result for ${filters.fromDate} to ${filters.toDate}:\n${rowBreakdown.join("\n")}` : `Matching live data was found for ${filters.fromDate} to ${filters.toDate}.`,
        roman: rowBreakdown.length ? `Live result (${filters.fromDate} to ${filters.toDate}):\n${rowBreakdown.join("\n")}` : `${filters.fromDate} to ${filters.toDate} ke liye matching live data mil gaya.`,
        urdu: rowBreakdown.length ? `لائیو نتیجہ (${filters.fromDate} سے ${filters.toDate}):\n${rowBreakdown.join("\n")}` : `${filters.fromDate} سے ${filters.toDate} کے لیے متعلقہ لائیو ڈیٹا مل گیا۔`,
      })
    : localizedText(language, { english:"No matching live data was found for the requested scope.", roman:"Requested scope mein matching live data nahi mila.", urdu:"درخواست کردہ دائرے میں متعلقہ لائیو ڈیٹا نہیں ملا۔" });
  let answer = fallbackAnswer;
  try {
    answer = await ollamaChat([
      { role: "system", content: `Answer in ${responseLanguage}. Use ONLY the supplied live rows and period. Keep every figure exact. Structure the reply as: (1) direct answer, (2) concise breakdown, (3) one data-supported observation when useful. Mention names/labels from live rows, not codes alone when a readable name is available. Never invent a cause, relationship, or number. If a cause is not provable from these rows, say what additional breakdown would verify it. Do not expose SQL. If rows are empty, say no matching live data was found.` },
      { role: "user", content: JSON.stringify({ question: message, period: filters, rows: rows.slice(0, 40) }) },
    ], {
      temperature: 0.1,
      timeoutMs: Math.min(aiConfig.ollamaTimeoutMs, 35000),
      numCtx: 8192,
      numPredict: 620,
      think: analysisThinkLevelForQuestion(message),
    });
  } catch (error) {
    console.warn("[AI Assistant] Planner explanation fallback:", error.message);
  }
  const metricValues = metricKey ? rows.map((row) => Number(row?.[metricKey] || 0)).filter(Number.isFinite) : [];
  const metricFormat = /amount|value/i.test(String(metricKey || "")) ? "currency" : "number";
  const metrics = metricValues.length ? [
    { key:"plannerTotal", label: language === "urdu" ? "کل" : "Total", format:metricFormat, value:metricValues.reduce((sum,value)=>sum+value,0) },
    { key:"plannerRows", label: language === "urdu" ? "قطاریں" : "Rows", format:"number", value:rows.length },
  ] : [{ key:"plannerRows", label: language === "urdu" ? "قطاریں" : "Rows", format:"number", value:rows.length }];
  const plannerAction = rows.length > 1 ? localizedText(language, { english:"Use the strongest and weakest live rows as the next drill-down points; keep the same period/scope for a follow-up question.", roman:"Strongest aur weakest live rows ko next drill-down points banayein; follow-up mein same period/scope automatically yaad rahega.", urdu:"مضبوط اور کمزور لائیو قطاروں کو اگلے ڈرل ڈاؤن پوائنٹس بنائیں؛ فالو اپ میں یہی مدت/دائرہ یاد رہے گا۔" }) : "";
  return {
    mode:"sql", answer, keyPoints:rowBreakdown, actions:[plannerAction].filter(Boolean), metrics,
    scope:`${filters.fromDate} to ${filters.toDate}`, rows, visualization:inferVisualization(rows),
  };
}

function inferVisualization(rows) {
  if (!rows?.length) return null;
  const columns = Object.keys(rows[0]);
  const label = columns.find((key) => typeof rows[0][key] === "string");
  const numeric = columns.find((key) => Number.isFinite(Number(rows[0][key])));
  if (!label || !numeric) return null;
  return { type: "bar", title: `${numeric} by ${label}`, data: rows.slice(0, 12).map((row) => ({ Label: String(row[label] ?? ""), Amount: Number(row[numeric] || 0) })) };
}

function compactMemoryFilters(filters) {
  const normalized = filters ? reportService.normalizeFilters(filters) : null;
  if (!normalized) return {};
  const out = { fromDate: normalized.fromDate, toDate: normalized.toDate };
  for (const [key, value] of Object.entries(normalized)) {
    if (Array.isArray(value) && value.length) out[key] = value.slice(0, 30);
  }
  return out;
}

function buildConversationMemory({ previous, originalQuestion, resolvedQuestion, semanticUnderstanding, filters, result, extra }) {
  const priorTurns = Array.isArray(previous?.turns) ? previous.turns.slice(-19) : [];
  const domain = semanticUnderstanding?.intent?.domain || previous?.domain || "";
  const dimension = semanticUnderstanding?.intent?.dimension || previous?.dimension || "";
  const route = String(extra?.route || previous?.route || "");
  const resolvedFilters = filters ? compactMemoryFilters(filters) : (previous?.filters || {});
  const isBusinessTurn = Boolean(domain) && !["schema"].includes(domain) && result?.mode !== "clarify";
  const anchorQuestion = isBusinessTurn
    ? String(resolvedQuestion || originalQuestion || "").slice(0, 1200)
    : String(previous?.anchorQuestion || resolvedQuestion || originalQuestion || "").slice(0, 1200);
  const turn = {
    question: String(originalQuestion || "").slice(0, 700),
    resolvedQuestion: String(resolvedQuestion || "").slice(0, 1200),
    answerSummary: String(result?.answer || "").slice(0, 1400),
    keyPoints: Array.isArray(result?.keyPoints) ? result.keyPoints.slice(0, 8).map((item) => String(item || "").slice(0, 500)) : [],
    metrics: Array.isArray(result?.metrics) ? result.metrics.slice(0, 10).map((item) => ({ key:String(item?.key || "").slice(0,80), label:String(item?.label || "").slice(0,120), format:String(item?.format || "number").slice(0,30), value:Number(item?.value || 0) })) : [],
    scope: String(result?.scope || "").slice(0,500),
    route, domain, dimension, filters: resolvedFilters,
  };
  return {
    version: 3,
    anchorQuestion,
    resolvedQuestion: String(resolvedQuestion || "").slice(0, 1600),
    domain,
    dimension,
    route,
    filters: resolvedFilters,
    turns: [...priorTurns, turn],
    updatedAt: new Date().toISOString(),
  };
}

async function answerAssistant({ tenantId, user, message, history = [], memory = null, languageMode = "english-roman" }) {
  const originalQuestion = String(message || "").trim();
  const question = resolveFollowUpQuestion(originalQuestion, history, memory);
  if (!question) throw Object.assign(new Error("Message is required"), { status: 400 });
  if (question.length > aiConfig.maxQuestionLength) throw Object.assign(new Error("Message is too long"), { status: 400 });

  const outputLanguage = resolveOutputLanguage(languageMode, originalQuestion);
  const trainingUnderstanding = resolveTrainingIntent(question, 10);
  const semanticUnderstanding = resolveSemanticTrainingIntent(question, 12);
  let activeFilters = memory?.filters ? reportService.normalizeFilters(memory.filters) : null;
  const finish = (result, extra = {}) => {
    const grounded = withTrainingGrounding(result, trainingUnderstanding, {
      ...semanticGroundingMetadata(semanticUnderstanding),
      ...extra,
    });
    return {
      ...grounded,
      memory: buildConversationMemory({
        previous: memory,
        originalQuestion,
        resolvedQuestion: question,
        semanticUnderstanding,
        filters: activeFilters,
        result: grounded,
        extra,
      }),
    };
  };

  if (/^(hi|hello|hey|salam|assalam|aoa|bhai|السلام علیکم|سلام)[!. ]*$/i.test(originalQuestion)) {
    return finish({
      mode: "direct",
      answer: localizedText(outputLanguage, {
        english: "Hello. Ask me naturally about live sales, purchase, stock, transfer, payments, targets, forecasts, or business analysis.",
        roman: "Walekum salam bhai. Sales, purchase, stock, transfer, payment, target, forecast ya business analysis ke bare mein normal language mein poochain.",
        urdu: "وعلیکم السلام۔ آپ سیلز، خریداری، اسٹاک، ٹرانسفر، ادائیگی، ہدف، پیش گوئی یا کاروباری تجزیے کے بارے میں عام زبان میں پوچھ سکتے ہیں۔",
      }),
    }, { liveVerified: false, route: "conversation", safetyMode: "direct" });
  }

  // The 650 schema-aware training questions should not be handed to a SQL
  // generator when their answer already exists in the uploaded structure.
  // Documented fields are answered from the workbook; undocumented fields
  // deliberately trigger clarification instead of a fabricated meaning.
  if (isSchemaKnowledgeQuestion(question)) {
    const schemaAnswer = answerSchemaQuestion(question, outputLanguage);
    if (schemaAnswer) {
      return finish(schemaAnswer, {
        liveVerified: false,
        route: "training-schema",
        safetyMode: schemaAnswer.mode === "clarify" ? "clarify-not-guess" : "documented-training-knowledge",
      });
    }
  }

  const pool = await getPoolForTenant(tenantId);
  let filters = inferFilters(question);
  filters = await resolveNamedBusinessFilters(pool, user, question, filters);
  filters = inheritConversationFilters(originalQuestion, filters, memory);
  activeFilters = filters;

  const clarification = clarificationForQuestion(originalQuestion, question, history, filters, outputLanguage);
  if (clarification) {
    return finish({
      mode: "clarify",
      answer: clarification.answer,
      keyPoints: [], actions: [], rows: [], visualization: null,
      followUpOptions: clarification.options || [],
    }, { liveVerified: false, route: "clarification", safetyMode: "clarify-not-guess" });
  }

  // 10,000-question semantic guard. The bank is not used as a source of live
  // facts; it is used to verify that the wording maps to one canonical POS
  // intent. If explicit wording and nearest training examples disagree, ask a
  // cross-question instead of running an unrelated report.
  if (semanticUnderstanding.unsafeAmbiguity) {
    const cross = semanticClarification(semanticUnderstanding, outputLanguage) || trainingClarification(trainingUnderstanding, outputLanguage);
    return finish({
      mode: "clarify",
      answer: cross.answer,
      keyPoints: [], actions: [], rows: [], visualization: null,
      followUpOptions: cross.options || [],
    }, { liveVerified: false, route: "semantic-ambiguity", safetyMode: "10k-intent-conflict-clarify" });
  }

  const predictiveIntent = forecastIntent(question);
  if (predictiveIntent) {
    const window = forecastWindow(question);
    if (predictiveIntent === "sales" || predictiveIntent === "demand") {
      const result = await buildSalesForecast({ pool, user, filters, question, language: outputLanguage, intent: predictiveIntent, window });
      return finish(result, { liveVerified: true, route: `forecast:${predictiveIntent}`, safetyMode: "deterministic-live-history-forecast" });
    }
    if (predictiveIntent === "stockout" || predictiveIntent === "reorder" || predictiveIntent === "stock") {
      const result = await buildStockPrediction({ pool, user, filters, question, language: outputLanguage, intent: predictiveIntent, window });
      return finish(result, { liveVerified: true, route: `forecast:${predictiveIntent}`, safetyMode: "deterministic-live-history-forecast" });
    }
    // "complex" future questions (profit/target/supplier/transfer/etc.) are not
    // silently converted into sales forecasts. They go to the guarded planner.
  }

  // ANALYSIS MUST RUN BEFORE GENERIC FAST REPORTS. Otherwise a sentence such as
  // "analyze this month's sales" can be mistaken for a plain sales-total query.
  const semanticRoute = semanticUnderstanding.route || { kind: "unknown" };

  if (businessAnalysisIntent(question) && semanticRoute.kind === "direct-engine") {
    let currentReport = null;
    if (semanticRoute.engine === "sales-return") {
      currentReport = await reportService.runSalesReturns(pool, user, filters, semanticRoute.dimension || null);
    } else if (semanticRoute.engine === "sales-dimension") {
      currentReport = await reportService.runSalesDimension(pool, user, filters, semanticRoute.dimension || "salesman");
    } else if (semanticRoute.engine === "purchase-return") {
      currentReport = await reportService.runPurchase(pool, user, filters, { isReturn: true, dimension: semanticRoute.dimension || null });
    } else if (semanticRoute.engine === "stock-take") {
      currentReport = await reportService.runSimpleInventory(pool, user, filters, "take");
    } else if (semanticRoute.engine === "adjustment") {
      currentReport = await reportService.runSimpleInventory(pool, user, filters, "adjustment");
    } else if (semanticRoute.engine === "supplier-payment") {
      currentReport = await accountingReportService.runSupplierPayments(pool, user, filters);
    }
    if (currentReport) {
      currentReport = { ...currentReport, code: `CHAT_${String(semanticRoute.engine || "DIRECT").toUpperCase().replace(/[^A-Z0-9]+/g,"_")}`, filters, source:"live-database", generatedAt:new Date().toISOString() };
      let previousReport = null;
      if (/(why|kyun|reason|cause|trend|growth|decline|compare|comparison|performance|analysis|analyze|analyse)/i.test(question) || /(کیوں|وجہ|رجحان|اضافہ|کمی|موازنہ|تجزیہ)/i.test(question)) {
        try {
          const previousFilters = previousComparableFilters(filters);
          if (semanticRoute.engine === "sales-return") previousReport = await reportService.runSalesReturns(pool, user, previousFilters, semanticRoute.dimension || null);
          else if (semanticRoute.engine === "sales-dimension") previousReport = await reportService.runSalesDimension(pool, user, previousFilters, semanticRoute.dimension || "salesman");
          else if (semanticRoute.engine === "purchase-return") previousReport = await reportService.runPurchase(pool, user, previousFilters, { isReturn:true, dimension:semanticRoute.dimension || null });
          else if (semanticRoute.engine === "supplier-payment") previousReport = await accountingReportService.runSupplierPayments(pool, user, previousFilters);
          if (previousReport) previousReport = { ...previousReport, filters: previousFilters };
        } catch (error) {
          console.warn("[AI Assistant] Previous direct-engine analysis scope skipped:", error.message);
        }
      }
      const narrative = await generateAssistantBusinessAnalysis({ currentReport, previousReport, question, language: outputLanguage });
      const result = assistantAnswerFromReport(currentReport, narrative, question, outputLanguage);
      result.mode = "analysis";
      return finish(result, { liveVerified:true, route:currentReport.code, safetyMode:narrative.warning ? "verified-analysis-fallback" : "verified-data-plus-ai-analysis" });
    }
  }

  const semanticAnalysisReportCode = businessAnalysisIntent(question) && semanticRoute.kind === "report" ? semanticRoute.code : null;
  const analysisCode = semanticAnalysisReportCode || (semanticRoute.kind === "planner" ? null : chooseVerifiedAnalysisReport(question));
  if (analysisCode) {
    const routeCheck = verifyReportRoute(question, analysisCode, trainingUnderstanding);
    if (!routeCheck.ok) {
      const cross = trainingClarification(trainingUnderstanding, outputLanguage);
      return finish({ mode: "clarify", answer: cross.answer, followUpOptions: cross.options || [] }, {
        liveVerified: false, route: analysisCode, safetyMode: "route-conflict-clarify", routeConflict: routeCheck.reason,
      });
    }
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
    const result = assistantAnswerFromReport(currentReport, narrative, question, outputLanguage);
    result.mode = "analysis";
    return finish(result, {
      liveVerified: true,
      route: analysisCode,
      safetyMode: narrative.warning ? "verified-analysis-fallback" : "verified-data-plus-ai-analysis",
    });
  }

  if (semanticRoute.kind === "direct-engine") {
    let report = null;
    if (semanticRoute.engine === "sales-return") report = await reportService.runSalesReturns(pool, user, filters, semanticRoute.dimension || null);
    else if (semanticRoute.engine === "sales-dimension") report = await reportService.runSalesDimension(pool, user, filters, semanticRoute.dimension || "salesman");
    else if (semanticRoute.engine === "purchase-return") report = await reportService.runPurchase(pool, user, filters, { isReturn:true, dimension:semanticRoute.dimension || null });
    else if (semanticRoute.engine === "stock-take") report = await reportService.runSimpleInventory(pool, user, filters, "take");
    else if (semanticRoute.engine === "adjustment") report = await reportService.runSimpleInventory(pool, user, filters, "adjustment");
    else if (semanticRoute.engine === "supplier-payment") report = await accountingReportService.runSupplierPayments(pool, user, filters);
    if (report) {
      report = { ...report, code:`CHAT_${String(semanticRoute.engine || "DIRECT").toUpperCase().replace(/[^A-Z0-9]+/g,"_")}`, filters, source:"live-database", generatedAt:new Date().toISOString() };
      let narrative = naturalFastNarrative(report, question, outputLanguage);
      if (wantsComparison(question) && ["sales-return","sales-dimension","purchase-return","supplier-payment"].includes(semanticRoute.engine)) {
        const previousFilters = previousComparableFilters(filters);
        let previous = null;
        if (semanticRoute.engine === "sales-return") previous = await reportService.runSalesReturns(pool, user, previousFilters, semanticRoute.dimension || null);
        else if (semanticRoute.engine === "sales-dimension") previous = await reportService.runSalesDimension(pool, user, previousFilters, semanticRoute.dimension || "salesman");
        else if (semanticRoute.engine === "supplier-payment") previous = await accountingReportService.runSupplierPayments(pool, user, previousFilters);
        else previous = await reportService.runPurchase(pool, user, previousFilters, { isReturn:true, dimension:semanticRoute.dimension || null });
        narrative = comparisonNarrative(report, { ...previous, filters:previousFilters }, question, outputLanguage);
      }
      return finish(assistantAnswerFromReport(report, narrative, question, outputLanguage), { liveVerified:true, route:report.code, safetyMode:"10k-semantic-verified-engine" });
    }
  }

  // Salesman questions have a verified dimension engine even though the static
  // report catalog does not expose a generic Salesman Wise Sales code.
  const routedQuestion = canonicalizeForRouting(question);
  const asksSalesmanSales = /\b(salesman|sales person|staff|employee)\b/i.test(routedQuestion)
    && /\b(sale|sales|selling|revenue|bikri|farokht|performance|top|bottom|best|worst)\b/i.test(routedQuestion);
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
    return finish(assistantAnswerFromReport(report, narrative, question, outputLanguage), {
      liveVerified: true, route: "CHAT_SALESMAN_WISE_SALES", safetyMode: "verified-live-sql",
    });
  }

  const fastCode = semanticRoute.kind === "report"
    ? semanticRoute.code
    : semanticRoute.kind === "planner"
      ? null
      : chooseFastReport(question);
  if (fastCode) {
    const routeCheck = verifyReportRoute(question, fastCode, trainingUnderstanding);
    if (!routeCheck.ok) {
      const cross = trainingClarification(trainingUnderstanding, outputLanguage);
      return finish({ mode: "clarify", answer: cross.answer, followUpOptions: cross.options || [] }, {
        liveVerified: false, route: fastCode, safetyMode: "route-conflict-clarify", routeConflict: routeCheck.reason,
      });
    }

    // Target/incentive catalog entries exist, but their calculations are more
    // policy-specific than generic sales reports. Until a deterministic target
    // engine is selected for the exact wording, use the guarded schema planner
    // instead of returning a wrong generic total.
    if (/^RPT_25_/.test(fastCode)) {
      try {
        const planned = await plannerFallback({ tenantId, pool, user, message: question, history: Array.isArray(history) ? history : [], memory, filters, language: outputLanguage, trainingUnderstanding });
        return finish(planned, { liveVerified: planned.mode === "sql", route: "guarded-target-planner", safetyMode: planned.mode === "clarify" ? "clarify-not-guess" : "guarded-live-sql" });
      } catch (error) {
        console.warn("[AI Assistant] Target/incentive guarded planner:", error.message);
        const cross = trainingClarification(trainingUnderstanding, outputLanguage);
        return finish({ mode: "clarify", answer: cross.answer, followUpOptions: cross.options || [] }, { liveVerified: false, route: "target-incentive", safetyMode: "clarify-not-guess" });
      }
    }

    const report = await reportService.runReport({ tenantId, user, code: fastCode, filters });
    let narrative = naturalFastNarrative(report, question, outputLanguage);
    if (wantsComparison(question)) {
      const previousFilters = previousComparableFilters(filters);
      const previousReport = await reportService.runReport({ tenantId, user, code: fastCode, filters: previousFilters });
      narrative = comparisonNarrative(report, previousReport, question, outputLanguage);
    }
    const result = assistantAnswerFromReport(report, narrative, question, outputLanguage);
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
    return finish(result, { liveVerified: true, route: fastCode, safetyMode: "verified-live-sql" });
  }

  // If neither a deterministic route nor a clear explicit business domain was
  // found and the 10k corpus itself is split between meanings, ask first. This
  // is the key anti-wrong-answer guard: uncertainty becomes a cross-question,
  // never a confident but unrelated report.
  if (trainingUnderstanding.ambiguous && !trainingUnderstanding.exact && !trainingUnderstanding.explicitDomain) {
    const cross = trainingClarification(trainingUnderstanding, outputLanguage);
    return finish({ mode: "clarify", answer: cross.answer, followUpOptions: cross.options || [] }, {
      liveVerified: false, route: "training-ambiguity", safetyMode: "clarify-not-guess",
    });
  }

  try {
    const planned = await plannerFallback({ tenantId, pool, user, message: question, history: Array.isArray(history) ? history : [], memory, filters, language: outputLanguage, trainingUnderstanding });
    return finish(planned, {
      liveVerified: planned.mode === "sql",
      route: "guarded-planner",
      safetyMode: planned.mode === "clarify" ? "clarify-not-guess" : planned.mode === "sql" ? "guarded-live-sql" : "direct",
    });
  } catch (error) {
    console.warn("[AI Assistant] Bounded planner fallback:", error.message);
    return finish({
      mode: "clarify",
      answer: localizedText(outputLanguage, {
        english: "I could not map this question to one verified business interpretation. Please make the metric, period, branch, product, or policy a little more specific. I will ask rather than return a potentially wrong answer.",
        roman: "Is sawal ki ek verified business interpretation clear nahi hui. Metric, period, branch, product ya policy thori specific kar dein. Main ghalat jawab dene ke bajaye cross-question karunga.",
        urdu: "اس سوال کی ایک تصدیق شدہ کاروباری تشریح واضح نہیں ہوئی۔ میٹرک، مدت، برانچ، پروڈکٹ یا پالیسی کو تھوڑا واضح کریں۔ میں ممکنہ غلط جواب دینے کے بجائے سوال کروں گا۔",
      }),
      followUpOptions: [],
    }, { liveVerified: false, route: "safe-fallback", safetyMode: "clarify-not-guess" });
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
  supportingKpisForBreakdown,
  inheritConversationFilters,
  buildConversationMemory,
};
