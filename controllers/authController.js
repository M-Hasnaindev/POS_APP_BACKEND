const { sql, pool } = require("../config/db");
const jwt = require("jsonwebtoken");

// ============================================
// LOGIN (PinCode based)
// ============================================
exports.login = async (req, res) => {
  try {
    const { pinCode } = req.body;

    if (!pinCode) {
      return res.status(400).json({
        success: false,
        message: "PinCode required",
      });
    }

    const db = await pool;

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

    // No user found
    if (result.recordset.length === 0) {
      return res.status(401).json({
        success: false,
        message: "Invalid PinCode",
      });
    }

    // Duplicate pin issue
    if (result.recordset.length > 1) {
      return res.status(400).json({
        success: false,
        message: "Duplicate PinCode found. Contact admin.",
      });
    }

    const user = result.recordset[0];

    // Generate JWT Token
    const token = jwt.sign(
      { userId: user.UserID },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    delete user.PinCode;

    res.json({
      success: true,
      message: "Login success",
      token,
      user,
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
};

// ============================================
// GET USER DETAIL
// ============================================
exports.getUserDetail = async (req, res) => {
  try {
    const db = await pool;

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
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      user: result.recordset[0],
    });

  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ============================================
// LOGOUT
// ============================================
exports.logout = async (req, res) => {
  try {
    res.json({
      success: true,
      message: "Logout successful (remove token from frontend)",
    });
  } catch (err) {
    res.status(500).json({ success: false });
  }
};

// ============================================
// ACCOUNT INFO API (NEW)
// Returns all account information
// ============================================
exports.getAccountInfo = async (req, res) => {
  try {
    const db = await pool;

    // Query exactly as provided - do NOT modify
    const result = await db.request().query(`
      Select * From AccountInfo
    `);

    res.json({
      success: true,
      data: result.recordset,
      count: result.recordset.length,
    });

  } catch (err) {
    console.log("ACCOUNT INFO ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// ============================================
// COMPANY LOG API (NEW)
// Returns FromDate and ToDate from Defaults
// ============================================
exports.getCompanyLog = async (req, res) => {
  try {
    const db = await pool;

    // Get companyId from query params or use empty string
    const companyId = req.query.companyId || '';

    // Query exactly as provided - do NOT modify
    const result = await db.request()
      .input("companyId", sql.VarChar, companyId)
      .query(`
        SELECT FromDate, ToDate FROM Defaults Where CompanyID = @companyId
      `);

    // Return first record if exists
    if (result.recordset.length > 0) {
      res.json({
        success: true,
        data: result.recordset[0],
      });
    } else {
      res.json({
        success: true,
        data: null,
        message: "No company log found",
      });
    }

  } catch (err) {
    console.log("COMPANY LOG ERROR:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

// GET ACCOUNT NAME (Auto Fetch API)
exports.getAccountName = async (req, res) => {
  try {
    const request = (await pool).request();

    const result = await request.query(`
      SELECT AccountName
      FROM AccountInfo
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json({
        msg: "No Account Found"
      });
    }

    console.log("AccountName fetched successfully");

    return res.json({
      accounts: result.recordset
    });

  } catch (err) {
    console.log("GetAccountName error:", err);
    return res.status(500).json({
      msg: "Server Error"
    });
  }
};