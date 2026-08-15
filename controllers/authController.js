const jwt = require("jsonwebtoken");
const { sql, getPoolForTenant, testTenantConnection } = require("../config/db");
const {
  resolveTenantByKey,
  getTenantById,
  getPublicTenant,
} = require("../config/tenants");

function signTenantToken(tenantId) {
  return jwt.sign(
    { type: "tenant", tenantId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.TENANT_TOKEN_EXPIRES_IN || "30d" },
  );
}

function verifyTenantToken(token) {
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.type !== "tenant" || !decoded.tenantId || !getTenantById(decoded.tenantId)) {
    throw new Error("Invalid tenant token");
  }
  return decoded;
}

// ============================================
// RESOLVE COMPANY KEY -> TENANT
// ============================================
exports.resolveTenant = async (req, res) => {
  try {
    const companyKey = String(req.body?.companyKey || "").trim();
    if (!companyKey) {
      return res.status(400).json({ success: false, message: "Company key required" });
    }

    const tenant = resolveTenantByKey(companyKey);
    if (!tenant) {
      return res.status(401).json({ success: false, message: "Invalid company key" });
    }

    // Fail early if the configured database cannot be reached.
    await testTenantConnection(tenant.id);

    return res.json({
      success: true,
      tenant: getPublicTenant(tenant),
      tenantToken: signTenantToken(tenant.id),
    });
  } catch (err) {
    console.error("TENANT RESOLVE ERROR:", err.message);
    return res.status(503).json({
      success: false,
      message: "Company database is currently unavailable",
    });
  }
};

// ============================================
// LOGIN (PinCode based + tenant binding)
// ============================================
exports.login = async (req, res) => {
  try {
    const pinCode = String(req.body?.pinCode || "").trim();
    const tenantToken = String(req.body?.tenantToken || "").trim();
    const hasSelectedUserId = Object.prototype.hasOwnProperty.call(req.body || {}, "userId");
    const hasSelectedCompanyCode = Object.prototype.hasOwnProperty.call(req.body || {}, "companyCode");
    const selectedUserId = String(req.body?.userId ?? "").trim();
    const selectedCompanyCode = String(req.body?.companyCode ?? "").trim();

    if (!pinCode) {
      return res.status(400).json({ success: false, message: "PinCode required" });
    }
    if (!tenantToken) {
      return res.status(400).json({ success: false, message: "Company selection required" });
    }

    let tenantPayload;
    try {
      tenantPayload = verifyTenantToken(tenantToken);
    } catch {
      return res.status(401).json({ success: false, message: "Company session expired. Enter company key again." });
    }

    const db = await getPoolForTenant(tenantPayload.tenantId);
    const result = await db.request()
      .input("pinCode", sql.VarChar, pinCode)
      .query(`
        SELECT 
          CompanyCode, UserID, ShortName, UserName,
          PinCode, UserType, EmailId, MobileNo,
          AllowBranches, AllowAccount, AllowProduct, UserImage
        FROM Security
        WHERE PinCode = @pinCode
      `);

    if (result.recordset.length === 0) {
      return res.status(401).json({ success: false, message: "Invalid PinCode" });
    }

    let matchingUsers = result.recordset;

    if (hasSelectedUserId || hasSelectedCompanyCode) {
      if (!hasSelectedUserId || !hasSelectedCompanyCode || !selectedUserId) {
        return res.status(400).json({
          success: false,
          message: "Both user and company selection are required",
        });
      }

      matchingUsers = matchingUsers.filter(
        (item) =>
          String(item.UserID ?? "").trim() === selectedUserId &&
          String(item.CompanyCode ?? "").trim() === selectedCompanyCode,
      );

      if (matchingUsers.length === 0) {
        return res.status(401).json({
          success: false,
          message: "Selected account does not match this PIN",
        });
      }
    }

    if (matchingUsers.length > 1) {
      return res.status(409).json({
        success: false,
        code: "USER_SELECTION_REQUIRED",
        message: "Select the company account you want to use",
        users: matchingUsers.map((item) => ({
          userId: String(item.UserID),
          companyCode: String(item.CompanyCode ?? "").trim(),
          displayName: String(item.UserName || item.ShortName || item.UserID),
        })),
      });
    }

    const user = matchingUsers[0];
    const token = jwt.sign(
      {
        type: "access",
        userId: user.UserID,
        companyCode: user.CompanyCode,
        tenantId: tenantPayload.tenantId,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "12h" },
    );

    delete user.PinCode;

    return res.json({
      success: true,
      message: "Login success",
      token,
      tenant: getPublicTenant(getTenantById(tenantPayload.tenantId)),
      user,
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

// ============================================
// GET USER DETAIL
// ============================================
exports.getUserDetail = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const result = await db.request()
      .input("userId", sql.VarChar, req.user.userId)
      .query(`
        SELECT 
          CompanyCode, UserID, ShortName, UserName,
          UserType, EmailId, MobileNo,
          AllowBranches, AllowAccount, AllowProduct, UserImage
        FROM Security
        WHERE UserID = @userId
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.json({ success: true, user: result.recordset[0] });
  } catch (err) {
    console.error("GET USER ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.logout = async (_req, res) => {
  return res.json({ success: true, message: "Logout successful" });
};

exports.getAccountInfo = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const result = await db.request().query("SELECT * FROM AccountInfo");
    return res.json({ success: true, data: result.recordset, count: result.recordset.length });
  } catch (err) {
    console.error("ACCOUNT INFO ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getCompanyLog = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const companyId = String(req.query.companyId || req.user.companyCode || "");
    const result = await db.request()
      .input("companyId", sql.VarChar, companyId)
      .query("SELECT FromDate, ToDate FROM Defaults WHERE CompanyID = @companyId");

    if (result.recordset.length > 0) {
      return res.json({ success: true, data: result.recordset[0] });
    }
    return res.json({ success: true, data: null, message: "No company log found" });
  } catch (err) {
    console.error("COMPANY LOG ERROR:", err.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

exports.getAccountName = async (req, res) => {
  try {
    const db = await getPoolForTenant(req.user.tenantId);
    const result = await db.request().query("SELECT AccountName FROM AccountInfo");
    if (result.recordset.length === 0) {
      return res.status(404).json({ msg: "No Account Found" });
    }
    return res.json({ accounts: result.recordset });
  } catch (err) {
    console.error("GetAccountName error:", err.message);
    return res.status(500).json({ msg: "Server Error" });
  }
};
