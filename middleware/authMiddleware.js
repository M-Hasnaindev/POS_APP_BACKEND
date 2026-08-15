const jwt = require("jsonwebtoken");
const { getTenantById } = require("../config/tenants");

function extractToken(req) {
  const header = req.headers.authorization || req.headers["authorization"];
  if (!header) return null;
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  return String(header).trim();
}

exports.verifyToken = (req, res, next) => {
  const token = extractToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== "access" || !decoded.userId || !decoded.tenantId) {
      return res.status(401).json({ success: false, message: "Invalid token" });
    }

    if (!getTenantById(decoded.tenantId)) {
      return res.status(401).json({ success: false, message: "Tenant no longer available" });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

exports.extractToken = extractToken;
