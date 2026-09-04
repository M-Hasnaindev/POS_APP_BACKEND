const { sql, getPoolForTenant } = require("../config/db");

function clean(value) {
  return String(value ?? "").trim();
}

async function resolveAiUserContext({ tenantId, user }) {
  const existing = clean(user?.companyCode);
  if (existing) return { ...user, companyCode: existing };

  const pool = await getPoolForTenant(tenantId);
  const request = pool.request();
  request.timeout = 15000;
  request.input("userId", sql.VarChar(100), clean(user?.userId));

  // First prefer an explicit non-blank company attached to this same security user.
  // If legacy Security rows leave CompanyCode blank, a single-company tenant can still
  // be resolved safely from BranchFile without exposing another company.
  const result = await request.query(`
    SELECT CompanyCode
    FROM Security
    WHERE UserID=@userId AND ISNULL(LTRIM(RTRIM(CompanyCode)),'')<>''
    GROUP BY CompanyCode;

    SELECT CompanyCode
    FROM BranchFile
    WHERE ISNULL(LTRIM(RTRIM(CompanyCode)),'')<>''
    GROUP BY CompanyCode;
  `);

  const securityCompanies = (result.recordsets?.[0] || []).map((row) => clean(row.CompanyCode)).filter(Boolean);
  if (securityCompanies.length === 1) {
    return { ...user, companyCode: securityCompanies[0], companyScopeResolvedBy: "Security" };
  }

  const tenantCompanies = (result.recordsets?.[1] || []).map((row) => clean(row.CompanyCode)).filter(Boolean);
  if (tenantCompanies.length === 1) {
    return { ...user, companyCode: tenantCompanies[0], companyScopeResolvedBy: "single-company-tenant" };
  }

  const error = new Error("AI company scope could not be resolved safely for this login. Please select a company account and sign in again.");
  error.status = 422;
  error.publicMessage = error.message;
  throw error;
}

module.exports = { resolveAiUserContext };
