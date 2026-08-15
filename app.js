const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "CherryTech POS API is running",
    endpoints: {
      auth: "/api/auth",
      sales: "/api/sales",
      health: "/api/health",
    },
  });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

const authRoutes = require("./routes/authRoutes");
const salesRoutes = require("./routes/salesRoutes");


app.use("/api/auth", authRoutes);
app.use("/api/sales", salesRoutes);

module.exports = app;
