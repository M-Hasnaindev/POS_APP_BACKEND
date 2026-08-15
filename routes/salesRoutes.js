// ============================================
// SALES ROUTES - UPDATED ARCHITECTURE
// ============================================
// ENDPOINTS:
// 1. GET /sales-report     → COMPLETE LAST YEAR (12 MONTHS) - FIX APPLIED
// 2. GET /sales-report-all → ALL Historical Data (for Background Sync)
// 3. GET /barcodes         → BarcodeView (LAST YEAR + CURRENT YEAR) - FIX APPLIED
// 4. GET /branch-list      → BranchList table
// 5. GET /employee-view    → Employee table
//
// ❌ NO /merged-sales endpoint (merge happens locally in SQLite)

const express = require("express");
const {
  getSalesReport,
  getSalesReportAll,
  getSalesReportCount,
  getBarcodes,
  getBranchList,
  getEmployeeView
} = require("../controllers/salesController");

const router = express.Router();

// ============================================
// CONFIG SCREEN APIs (FAST - LAST YEAR)
// ============================================
// 1. Sales Report - COMPLETE LAST YEAR (12 MONTHS) - FIX APPLIED
router.get("/sales-report", getSalesReport);

// 2. Barcode View - LAST YEAR + CURRENT YEAR (100K+ records) - FIX APPLIED
router.get("/barcodes", getBarcodes);

// 3. Branch List - All branches
router.get("/branch-list", getBranchList);

// 4. Employee View - All employees
router.get("/employee-view", getEmployeeView);

// ============================================
// BACKGROUND SYNC APIs (ALL HISTORICAL DATA)
// ============================================
// 5. Sales Report Count - Get total records for pagination progress
router.get("/sales-report-count", getSalesReportCount);

// 6. Sales Report All - For background sync (PAGINATED)
//    Supports: ?page=1&pageSize=5000
router.get("/sales-report-all", getSalesReportAll);

// ============================================
// ❌ REMOVED ENDPOINTS (No longer needed)
// ============================================
// - /merged-sales (merge happens locally)
// - /sales-detail (not used in new architecture)
// - /sales-report-by-date (handled locally)

module.exports = router;