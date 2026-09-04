function finiteNumber(value) {
  if (value === null || value === "" || value instanceof Date) return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function displayValue(value) {
  if (value instanceof Date) return value.toISOString();
  return value === null || value === undefined ? "" : String(value);
}

function wantsVisualization(question) {
  const text = String(question || "").toLowerCase();
  return /\b(graph|chart|graphical|visual|trend|compare|comparison|versus|vs|growth|grow|percent|percentage|branch[- ]?wise|store[- ]?wise|day[- ]?wise|daily|month[- ]?wise|monthly|year[- ]?wise|top|bottom|ranking|breakdown|distribution|mix)\b/.test(text);
}

function buildVisualization(rows, question = "") {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // A chart is an analytical aid, not a compulsory decoration. Aggregate
  // answers and ordinary lookups remain text/table responses unless the user
  // asks for a comparison, trend, distribution or graphical view.
  if (!wantsVisualization(question) || rows.length < 2) return null;
  const columns = Object.keys(rows[0] || {}).slice(0, 8);
  if (!columns.length) return null;
  const numericColumns = columns.filter((column) =>
    !/(^id$|code$|barcode|transaction(number)?|bill(no|number)?|date|time)/i.test(column)
    && rows.some((row) => finiteNumber(row[column]) !== null),
  ).slice(0, 3);
  const hasMeaningfulValue = numericColumns.some((column) =>
    rows.some((row) => Math.abs(finiteNumber(row[column]) || 0) > 0),
  );
  if (!hasMeaningfulValue) return null;
  const labelColumn = columns.find((column) => !numericColumns.includes(column)) || columns[0];
  const tableRows = rows.slice(0, 20).map((row) =>
    Object.fromEntries(columns.map((column) => [column, displayValue(row[column])])),
  );
  const title = String(question || "Live database result").trim().slice(0, 90);

  if (numericColumns.length) {
    const chartRows = rows.slice(0, 12);
    const looksTemporal = /date|day|week|month|year|time/i.test(labelColumn);
    return {
      type: looksTemporal ? "line" : "bar",
      title,
      labels: chartRows.map((row, index) => displayValue(row[labelColumn]) || `#${index + 1}`),
      series: numericColumns.map((column) => ({
        name: column,
        values: chartRows.map((row) => finiteNumber(row[column]) || 0),
      })),
      columns,
      rows: tableRows,
    };
  }
  return null;
}

module.exports = { buildVisualization, wantsVisualization };
