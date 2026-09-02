const assert = require("assert");
const { validateReadOnlySql } = require("../ai/sqlSafety");

const allowed = ["PosDetail", "PosMaster", "BranchFile"];

assert.doesNotThrow(() => validateReadOnlySql(
  "SELECT TOP 10 d.TransactionNumber FROM PosDetail d JOIN PosMaster m ON m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode",
  allowed,
));
assert.throws(() => validateReadOnlySql("DELETE FROM PosDetail", allowed), /Only SELECT|Unsafe/);
assert.throws(() => validateReadOnlySql("SELECT * FROM PosDetail; DROP TABLE PosDetail", allowed), /Unsafe/);
assert.throws(() => validateReadOnlySql("SELECT UserID FROM Security WHERE CompanyCode=@companyCode", allowed), /unavailable table/i);
assert.throws(() => validateReadOnlySql("SELECT * FROM INFORMATION_SCHEMA.COLUMNS", allowed), /Unsafe/);

console.log("AI SQL safety tests passed");
