const { trainingKnowledge } = require("./knowledge");

function allTables() {
  return {
    ...(trainingKnowledge.tables || {}),
    ...(trainingKnowledge.undocumentedLiveTables || {}),
  };
}

function findTable(name) {
  const wanted = String(name || "").toLowerCase();
  return Object.entries(allTables()).find(([table]) => table.toLowerCase() === wanted) || null;
}

function findField(tableInfo, fieldName) {
  const wanted = String(fieldName || "").toLowerCase();
  return (tableInfo?.fields || []).find((field) => String(field?.name || "").toLowerCase() === wanted) || null;
}

function isUndocumented(field) {
  const text = `${field?.status || ""} ${field?.meaning || ""} ${field?.rule || ""}`.toLowerCase();
  return /not fully documented|not defined|do not guess|undocumented|meaning.*not.*documented/.test(text);
}

function schemaReference(question) {
  const raw = String(question || "");
  const match = raw.match(/\b([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)\b/);
  if (match) return { tableName: match[1], fieldName: match[2] };

  // Table-only questions such as "PosTargetMaster ka purpose kya hai?"
  for (const tableName of Object.keys(allTables())) {
    const re = new RegExp(`\\b${tableName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(raw)) return { tableName, fieldName: null };
  }
  return null;
}

function wrap(language, english, roman, urdu) {
  if (language === "urdu") return urdu || english;
  if (language === "roman") return roman || english;
  return english;
}

function isSchemaKnowledgeQuestion(question) {
  const raw = String(question || "");
  const hasReference = Boolean(schemaReference(raw));
  if (!hasReference) return false;
  return /\b(business meaning|field meaning|meaning|what is|what does|represents?|field|column|table purpose|schema|documented|explain this field|how should.*explain|what business question|can be answered using)\b/i.test(raw)
    || /(بزنس.*مطلب|کاروباری.*مطلب|معنی|فیلڈ|کالم|ٹیبل|کیا ہے|سمجھا)/i.test(raw)
    || /\b(kya hai|ka matlab|meaning kya|business question|kis sawal|kaunsa sawal)\b/i.test(raw);
}

function answerSchemaQuestion(question, language = "english") {
  const ref = schemaReference(question);
  if (!ref) return null;
  const tablePair = findTable(ref.tableName);
  if (!tablePair) return null;
  const [canonicalTable, table] = tablePair;

  if (!ref.fieldName) {
    const details = [
      table.purpose ? `Purpose: ${table.purpose}` : "",
      table.mainJoin ? `Main join: ${table.mainJoin}` : "",
      table.importantRule ? `Important rule: ${table.importantRule}` : "",
      table.stockEffect ? `Stock effect: ${table.stockEffect}` : "",
    ].filter(Boolean).join("\n");
    return {
      mode: "knowledge",
      answer: wrap(
        language,
        `${canonicalTable}\n${details}`,
        `${canonicalTable} ka documented business meaning:\n${details}`,
        `${canonicalTable} کا دستاویزی کاروباری مطلب:\n${details}`,
      ),
      source: "training-workbooks",
      documented: true,
    };
  }

  const field = findField(table, ref.fieldName);
  if (!field) {
    return {
      mode: "clarify",
      answer: wrap(
        language,
        `I found table ${canonicalTable}, but field ${ref.fieldName} is not documented in the uploaded training structure. Please confirm the exact field name instead of letting me guess.`,
        `${canonicalTable} table mil gaya, lekin ${ref.fieldName} field uploaded training structure mein documented nahi hai. Exact field name confirm kar dein; main guess nahi karunga.`,
        `${canonicalTable} ٹیبل مل گیا، لیکن ${ref.fieldName} فیلڈ اپ لوڈ کردہ ٹریننگ اسٹرکچر میں دستاویزی نہیں ہے۔ براہِ کرم درست فیلڈ نام بتائیں؛ میں اندازہ نہیں لگاؤں گا۔`,
      ),
      source: "training-workbooks",
      documented: false,
    };
  }

  if (isUndocumented(field)) {
    return {
      mode: "clarify",
      answer: wrap(
        language,
        `${canonicalTable}.${field.name} exists, but its exact business meaning is not documented in the supplied structure. I will not use it in a calculation until you confirm its meaning.`,
        `${canonicalTable}.${field.name} field mojood hai, lekin supplied structure mein iska exact business meaning documented nahi hai. Meaning confirm honay tak main is field ko calculation mein use nahi karunga.`,
        `${canonicalTable}.${field.name} فیلڈ موجود ہے، لیکن فراہم کردہ اسٹرکچر میں اس کا درست کاروباری مطلب دستاویزی نہیں ہے۔ مطلب کی تصدیق تک میں اسے حساب میں استعمال نہیں کروں گا۔`,
      ),
      source: "training-workbooks",
      documented: false,
    };
  }

  const lines = [
    `${canonicalTable}.${field.name}: ${field.meaning || "Documented field."}`,
    field.rule ? `Rule: ${field.rule}` : "",
    table.mainJoin ? `Related join: ${table.mainJoin}` : "",
  ].filter(Boolean);
  const asksBusinessQuestion = /what business question|business question can be answered|kis sawal|kaunsa sawal|kya pooch/i.test(String(question || ""));
  if (asksBusinessQuestion) {
    lines.push(`Safe question example: "Show ${field.meaning || field.name} using ${canonicalTable}.${field.name}."`);
  }

  return {
    mode: "knowledge",
    answer: wrap(
      language,
      lines.join("\n"),
      `Documented meaning:\n${lines.join("\n")}`,
      `دستاویزی مطلب:\n${lines.join("\n")}`,
    ),
    source: "training-workbooks",
    documented: true,
  };
}

module.exports = { answerSchemaQuestion, schemaReference, isSchemaKnowledgeQuestion };
