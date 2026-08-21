const express = require("express");
const router = express.Router();

const productController = require("../controllers/productController");
const { verifyToken } = require("../middleware/authMiddleware");

router.use(verifyToken);

router.get(
  "/search",
  productController.searchProduct
);

router.get("/search-stock", productController.searchStock);

router.get(
  "/barcode/:barcode",
  productController.getProductByBarcode
);

router.get("/stock/:barcode", productController.getStockReport);

module.exports = router;
