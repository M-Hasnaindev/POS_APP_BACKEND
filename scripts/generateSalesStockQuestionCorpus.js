const fs = require("node:fs");
const path = require("node:path");
const { DIMENSIONS, METRICS } = require("../services/salesStockSemantics");

const LIMIT = 10000;
const periods = {
  en: ["today", "yesterday", "this week", "this month", "the last 30 days", "the available data period"],
  roman: ["aaj", "kal ke completed data mein", "is week", "is month", "pichlay 30 din", "available data period mein"],
  urdu: ["آج", "گزشتہ مکمل دن", "اس ہفتے", "اس مہینے", "گزشتہ 30 دن", "دستیاب ڈیٹا کی مدت میں"],
};
const personas = ["owner", "manager", "stock-controller", "sales-manager", "auditor", "rushed-user", "decision-maker"];
const views = ["summary", "detail", "ranking", "comparison", "exception", "decision"];

function metricLabel(metric, language) {
  const roman = { "net sales": "net sales", "net quantity": "sold quantity", "gross profit": "gross profit", "gross margin": "gross margin", discount: "discount", returns: "returns", "bill count": "bills ki tadaad", "average bill value": "average bill value", "current stock": "current stock", "stock value": "stock value", "opening stock": "opening stock", purchases: "purchases", "sales movement": "sales movement", transfers: "transfers", "in-transit stock": "in-transit stock", "days cover": "stock cover days", "dead stock": "dead stock" };
  const urdu = { "net sales": "نیٹ سیلز", "net quantity": "فروخت شدہ مقدار", "gross profit": "گراس منافع", "gross margin": "گراس مارجن", discount: "ڈسکاؤنٹ", returns: "ریٹرنز", "bill count": "بلوں کی تعداد", "average bill value": "اوسط بل ویلیو", "current stock": "موجودہ اسٹاک", "stock value": "اسٹاک ویلیو", "opening stock": "اوپننگ اسٹاک", purchases: "خریداری", "sales movement": "سیلز موومنٹ", transfers: "ٹرانسفرز", "in-transit stock": "راستے میں موجود اسٹاک", "days cover": "اسٹاک کور کے دن", "dead stock": "ڈیڈ اسٹاک" };
  return language === "urdu" ? urdu[metric] : language === "roman" ? roman[metric] : metric;
}

function question(language, domain, dimension, metric, period, view, persona, variant) {
  const d = DIMENSIONS[dimension][language === "roman" ? "roman" : language === "urdu" ? "urdu" : "en"];
  const m = metricLabel(metric, language);
  const rank = variant % 2 ? "top aur bottom" : "best aur weak";
  if (language === "urdu") {
    const forms = [
      `${period} کی ${d} کے حساب سے ${m} کی مکمل تفصیل دکھائیں۔`,
      `${period} میں ${d} وائز ${m} میں ${rank === "top aur bottom" ? "سب سے اوپر اور نیچے" : "بہترین اور کمزور"} کون ہے؟`,
      `${d} کے لحاظ سے ${period} کا ${m} مختصر بتائیں اور غیر معمولی نتیجہ واضح کریں۔`,
      `${period} میں ${d} کی ${m} کا موازنہ کریں، پھر عملی قدم بتائیں۔`,
      `مالک کے لیے ${period} کی ${d} وائز ${m} رپورٹ بنائیں۔`,
      `${period} میں کس ${d} کی ${m} توجہ مانگتی ہے اور کیوں؟`,
    ];
    return forms[variant % forms.length];
  }
  if (language === "roman") {
    const forms = [
      `${period} ${d}-wise ${m} ka complete breakup dikhao.`,
      `${period} mein ${d} ke hisaab se ${rank} ${m} konsa hai?`,
      `${d}-wise ${period} ka ${m} short mein batao aur unusual result highlight karo.`,
      `${period} ka ${d} level ${m} compare karke practical next action batao.`,
      `Owner ke liye ${period} ki ${d}-wise ${m} report banao.`,
      `${period} mein kis ${d} ka ${m} attention mangta hai aur measurable reason kya hai?`,
    ];
    return forms[variant % forms.length];
  }
  const forms = [
    `Show the complete ${d}-wise ${m} breakdown for ${period}.`,
    `Which ${d} has the ${rank} ${m} for ${period}?`,
    `Summarize ${m} by ${d} for ${period} and flag unusual results.`,
    `Compare ${m} at ${d} level for ${period}, then suggest a practical next action.`,
    `Prepare an owner-ready ${d}-wise ${m} report for ${period}.`,
    `Which ${d} needs attention for ${m} in ${period}, and what measurable evidence supports it?`,
  ];
  return forms[variant % forms.length];
}

const records = [];
const seen = new Set();
const languages = ["english", "roman", "urdu"];
let round = 0;
while (records.length < LIMIT) {
  for (const language of languages) for (const domain of ["sales", "stock"]) {
    for (const [dimension, meta] of Object.entries(DIMENSIONS)) {
      if (!meta.domains.includes(domain)) continue;
      for (const metric of METRICS[domain]) {
        const variant = round % 6;
        const period = periods[language === "english" ? "en" : language][(round + records.length) % 6];
        const text = question(language, domain, dimension, metric, period, views[(round + variant) % views.length], personas[(records.length + round) % personas.length], variant);
        if (seen.has(text)) continue;
        seen.add(text);
        records.push({
          id: `SSQ-${String(records.length + 1).padStart(5, "0")}`,
          question: text,
          language,
          persona: personas[(records.length + round) % personas.length],
          domain,
          view: views[(round + variant) % views.length],
          intent: `${domain}.${dimension}.${metric.replace(/\s+/g, "-")}`,
          dimension,
          dimensionColumn: meta.column,
          metric,
          liveDataRequired: true,
          answerContract: "Answer only from permission-scoped SalesFacts/StockFacts; disclose period and filters; never memorize a changing numeric answer.",
          validation: domain === "sales" ? "Reconcile signed sales totals and distinct BillKey where bills are requested." : "Reconcile current balances and disclose the StockFacts snapshot period.",
        });
        if (records.length === LIMIT) break;
      }
      if (records.length === LIMIT) break;
    }
    if (records.length === LIMIT) break;
  }
  round += 1;
  if (round > 100) throw new Error(`Could only generate ${records.length} unique questions`);
}

const target = path.join(__dirname, "..", "ai", "salesStockQuestionCorpus.jsonl");
const output = records.slice(0, LIMIT);
fs.writeFileSync(target, output.map((record) => JSON.stringify(record)).join("\n") + "\n");
console.log(`Generated ${output.length} multilingual live-data questions at ${target}`);
