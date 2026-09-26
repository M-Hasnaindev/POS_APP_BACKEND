const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "ai", "businessReportCatalog.json");

function readSource() {
  const legacy = path.join(root, "ai", "reportCatalog.generated.json");
  if (fs.existsSync(legacy)) return fs.readFileSync(legacy, "utf8");
  return execFileSync("git", ["show", "HEAD:ai/reportCatalog.generated.json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

const source = JSON.parse(readSource());
const discountIndex = source.findIndex((item) => item.code === "RPT_16_016_DISCOUNT_POLICY_COMPLIANCE");
if (discountIndex >= 0) source.splice(313, 0, source.splice(discountIndex, 1)[0]);
const catalog = source.map((item, index) => ({
  id: index + 1,
  uiVariant: index + 1,
  code: String(item.code),
  name: String(item.name),
  category: String(item.category),
  family: String(item.family || "business"),
  mode: String(item.mode || "descriptive"),
  dimension: item.dimension == null ? null : String(item.dimension),
  uiFamily: String(item.uiFamily || "summary"),
  chartType: ["bar", "line", "pie", "none"].includes(item.chartType) ? item.chartType : "bar",
  metrics: Array.isArray(item.metrics) ? item.metrics.map(String) : [],
  needsAmountQuantityPair: Boolean(item.needsAmountQuantityPair),
  analysisContract: String(item.analysisContract || ""),
  advice: String(item.advice || ""),
  descriptionLines: Array.isArray(item.descriptionLines) ? item.descriptionLines.map(String) : [],
  sourceDescriptionLines: Array.isArray(item.sourceDescriptionLines) ? item.sourceDescriptionLines.map(String) : [],
}));

if (catalog.length !== 460) throw new Error(`Expected 460 reports, received ${catalog.length}`);
if (new Set(catalog.map((item) => item.code)).size !== 460) throw new Error("Report codes are not unique");
if (new Set(catalog.map((item) => item.uiVariant)).size !== 460) throw new Error("UI variants are not unique");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`Generated ${catalog.length} reports at ${output}`);
