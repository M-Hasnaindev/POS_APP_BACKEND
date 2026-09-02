const reports = require("./reportCatalog.generated.json");

module.exports = reports.map((report) => ({
  ...report,
  engine: "adaptive",
  description: report.descriptionLines[0],
}));
