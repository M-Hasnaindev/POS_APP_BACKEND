const assert = require("assert");
const { validateReadOnlySql } = require("../ai/sqlSafety");
const {
  allowedTables,
  trainingKnowledge,
  trainingContextForTables,
} = require("../ai/knowledge");

const allowed = ["PosDetail", "PosMaster", "BranchFile"];

assert.doesNotThrow(() => validateReadOnlySql(
  "SELECT TOP 10 d.TransactionNumber FROM PosDetail d JOIN PosMaster m ON m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode",
  allowed,
));
assert.throws(() => validateReadOnlySql("DELETE FROM PosDetail", allowed), /Only SELECT|Unsafe/);
assert.throws(() => validateReadOnlySql("SELECT * FROM PosDetail; DROP TABLE PosDetail", allowed), /Unsafe/);
assert.throws(() => validateReadOnlySql("SELECT UserID FROM Security WHERE CompanyCode=@companyCode", allowed), /unavailable table/i);
assert.throws(() => validateReadOnlySql("SELECT * FROM INFORMATION_SCHEMA.COLUMNS", allowed), /Unsafe/);

const requiredAiTables = [
  "BarcodeView", "PosMaster", "PosDetail", "UnPosMaster", "UnPosDetail",
  "PosPurchaseM", "PosPurchaseD", "PosPReturnM", "PosPReturnD",
  "PosStockAdjM", "PosStockAdjD", "PosTransferM", "PosTransferD",
  "PosBarOpen", "PosBarcodeAdjM", "PosBarcodeAdjD",
];
assert.deepStrictEqual(requiredAiTables.filter((table) => !allowedTables.includes(table)), []);
assert.strictEqual(Object.keys(trainingKnowledge.tables || {}).length, 32);
assert.ok(trainingContextForTables(["PosMaster", "PosDetail"], "sales").includes("TABLE SEMANTICS"));
assert.doesNotThrow(() => validateReadOnlySql(
  "SELECT TOP 10 CompanyCode,TransactionNumber,BarCode,BarCodeAdj,Quantity FROM PosBarcodeAdjD WHERE CompanyCode=@companyCode",
  requiredAiTables,
));

console.log("AI SQL safety tests passed");
