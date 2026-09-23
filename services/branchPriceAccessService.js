const { sql, getPoolForTenant } = require("../config/db");

function normalizeFlag(value) {
  return String(value || "").trim().toUpperCase();
}

function isAdminUserType(value) {
  return normalizeFlag(value) === "A";
}

function parsePosType(value) {
  const raw = String(value ?? "").trim();
  const compact = raw.toUpperCase().replace(/\s+/g, "");

  // Existing POS behavior is retail when PosType has never been configured.
  if (!compact) {
    return {
      rawPosType: raw,
      posType: "RP",
      allowRetail: true,
      allowWholesale: false,
    };
  }

  const allowRetail = compact.includes("RP");
  const allowWholesale = compact.includes("WS");

  // Preserve the old retail behavior for an unexpected legacy value instead
  // of accidentally exposing wholesale pricing.
  if (!allowRetail && !allowWholesale) {
    return {
      rawPosType: raw,
      posType: "RP",
      allowRetail: true,
      allowWholesale: false,
    };
  }

  return {
    rawPosType: raw,
    posType: allowRetail && allowWholesale ? "RP,WS" : allowWholesale ? "WS" : "RP",
    allowRetail,
    allowWholesale,
  };
}

function summarizePricing(branches) {
  const allowRetail = branches.some((branch) => branch.AllowRetail);
  const allowWholesale = branches.some((branch) => branch.AllowWholesale);

  return {
    allowRetail,
    allowWholesale,
    pricingMode:
      allowRetail && allowWholesale
        ? "BOTH"
        : allowWholesale
          ? "WHOLESALE"
          : allowRetail
            ? "RETAIL"
            : "NONE",
  };
}

async function getBranchPriceAccess({ tenantId, userId, companyCode, pool }) {
  const connection = pool || (await getPoolForTenant(tenantId));
  const safeUserId = String(userId || "").trim();
  const safeCompanyCode = String(companyCode || "").trim();

  if (!safeUserId) {
    throw new Error("User ID is required to resolve branch pricing access");
  }

  const securityResult = await connection
    .request()
    .input("userId", sql.VarChar(10), safeUserId)
    .input("companyCode", sql.VarChar(6), safeCompanyCode)
    .query(`
      SELECT TOP 1 CompanyCode, UserID, UserType, AllowBranches
      FROM Security
      WHERE UserID = @userId
        AND ISNULL(CompanyCode, '') = @companyCode
    `);

  if (!securityResult.recordset.length) {
    throw new Error("Security user not found for branch pricing access");
  }

  const security = securityResult.recordset[0];
  const userType = normalizeFlag(security.UserType);
  const isAdmin = isAdminUserType(userType);
  const allowBranches = normalizeFlag(security.AllowBranches) === "Y" ? "Y" : "N";

  let branchResult;
  if (allowBranches === "Y") {
    branchResult = await connection
      .request()
      .input("companyCode", sql.VarChar(6), safeCompanyCode)
      .query(`
        SELECT
          BranchCode,
          BranchName,
          ShortName,
          CompanyCode,
          PosType
        FROM BranchFile
        WHERE ISNULL(CompanyCode, '') = @companyCode
        ORDER BY BranchName, BranchCode
      `);
  } else {
    branchResult = await connection
      .request()
      .input("userId", sql.VarChar(10), safeUserId)
      .input("companyCode", sql.VarChar(6), safeCompanyCode)
      .query(`
        SELECT
          bf.BranchCode,
          bf.BranchName,
          bf.ShortName,
          bf.CompanyCode,
          bf.PosType
        FROM SecurityBranches sb
        INNER JOIN BranchFile bf
          ON bf.BranchCode = sb.BranchCode
         AND ISNULL(bf.CompanyCode, '') = @companyCode
        WHERE sb.UserId = @userId
          AND (
            ISNULL(sb.CompanyCode, '') = @companyCode
            OR ISNULL(sb.CompanyCode, '') = ''
          )
        ORDER BY bf.BranchName, bf.BranchCode
      `);
  }

  const seen = new Set();
  const branches = (branchResult.recordset || [])
    .filter((branch) => {
      const key = String(branch.BranchCode || "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((branch) => {
      const parsed = parsePosType(branch.PosType);
      return {
        BranchCode: String(branch.BranchCode || "").trim(),
        BranchName: String(branch.BranchName || "").trim(),
        ShortName: String(branch.ShortName || "").trim(),
        CompanyCode: String(branch.CompanyCode || "").trim(),
        PosType: parsed.posType,
        RawPosType: parsed.rawPosType,
        AllowRetail: parsed.allowRetail,
        AllowWholesale: parsed.allowWholesale,
      };
    });

  // Admins are not restricted by branch PosType. This decision is made on the
  // server from Security.UserType so a mobile client cannot grant itself access.
  const summary = isAdmin
    ? {
        allowRetail: true,
        allowWholesale: true,
        pricingMode: "BOTH",
      }
    : summarizePricing(branches);

  return {
    userId: safeUserId,
    companyCode: safeCompanyCode,
    userType,
    isAdmin,
    pricingAccessSource: isAdmin ? "ADMIN_OVERRIDE" : "BRANCH_POS_TYPE",
    allowBranches,
    ...summary,
    branches,
  };
}

function applyPriceAccessToProduct(product, priceAccess) {
  if (!product || typeof product !== "object") return product;

  const safe = { ...product };
  if (!priceAccess?.allowRetail) {
    safe.RetailPrice = null;
    safe.DiscountPrice = null;
    safe.DiscountPercent = null;
    safe.RetailPriceBH = null;
    safe.DiscountPriceBH = null;
  }

  if (!priceAccess?.allowWholesale) {
    safe.WholesalePrice = null;
    safe.WholeSalePriceBH = null;
  }

  return safe;
}

module.exports = {
  getBranchPriceAccess,
  applyPriceAccessToProduct,
  isAdminUserType,
  parsePosType,
};
