const jwt = require("jsonwebtoken");
const { getTenantById } = require("../config/tenants");

function extractToken(req) {
  const header = req.headers.authorization || req.headers["authorization"];
  if (!header) return null;
  if (/^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  return String(header).trim();
}

exports.verifyToken = async (req, res, next) => {
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

    if (!Object.prototype.hasOwnProperty.call(decoded, "companyCode")) {
      return res.status(401).json({ success: false, code: "ACCESS_IDENTITY_REQUIRED", message: "Please sign in again." });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
};

exports.extractToken = extractToken;

// Recovery is limited to this read-only status endpoint. Expired credentials
// never authorize a business request or issue a replacement access token.
exports.accessStatus = async (req,res) => {
  let decoded;
  try {
    decoded=jwt.verify(extractToken(req),process.env.JWT_SECRET,{algorithms:['HS256'],ignoreExpiration:true});
    if(decoded.type!=='access'||!decoded.userId||!decoded.tenantId||!Object.prototype.hasOwnProperty.call(decoded,'companyCode')||!Number.isFinite(decoded.exp)||!getTenantById(decoded.tenantId))throw Error('Invalid identity');
  } catch {
    return res.status(401).json({success:false,message:'Invalid access identity'});
  }
  const expired=decoded.exp*1000<=Date.now();
  return res.json({success:true,allowed:!expired,reauthenticate:expired,checkedAt:new Date().toISOString()});
};
