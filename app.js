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
      notifications: "/api/notifications",
      products: "/api/products",
      stock: "/api/stock",
      resources: "/api/resources",
      intelligence: "/api/intelligence",
      versionUpdates: "/api/versionupdates",
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
const notificationRoutes = require("./routes/notificationRoutes");
const productRoutes = require("./routes/productRoutes");
const versionUpdateRoutes = require("./routes/versionUpdateRoutes");
const stockRoutes = require("./routes/stockRoutes");
const knowledgeRoutes = require("./routes/knowledgeRoutes");
const intelligenceRoutes = require("./routes/intelligenceRoutes");


app.use("/api/auth", authRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/products", productRoutes);
app.use("/api/versionupdates", versionUpdateRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/resources", knowledgeRoutes);
app.use("/api/intelligence", intelligenceRoutes);

module.exports = app;
