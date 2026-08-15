const sql = require("mssql");
require("dotenv").config();

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT),

  options: {
    encrypt: false,
    trustServerCertificate: true,
  },

  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },

  requestTimeout: 300000, // 🔥 5 minutes (IMPORTANT)
  connectionTimeout: 30000, // optional
};

const pool = new sql.ConnectionPool(config)
  .connect()
  .then(pool => {
    console.log("✅ MSSQL Connected");
    return pool;
  })
  .catch(err => {
    console.log("❌ DB Error:", err);
  });

module.exports = { sql, pool };