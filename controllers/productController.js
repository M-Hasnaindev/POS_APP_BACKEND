const { sql, getPoolForTenant } = require("../config/db");
const COMPANY_TIME_ZONE = "Asia/Karachi";
const EMPTY_STOCK_FILTERS = [
  "Brand",
  "CoBrand",
  "CoBrandClass",
  "Catagory",
  "SubCatagory",
  "Style",
  "SubStyle",
  "StyleClass",
  "SubStyle1",
  "SubStyle2",
  "Department",
  "SubDepartment",
  "Season",
  "Fabric",
  "FabricClass",
  "Color",
  "ColorClass",
  "Size",
  "Gender",
];

/* ================= NORMALIZE FUNCTION ================= */
const normalize = (value) => {
  return value.replace(/-/g, "").trim();
};

const getToday = () => {
  // Resolve the business date in Pakistan without adding another runtime
  // dependency. en-CA gives a stable YYYY-MM-DD shape on modern Node/Vercel.
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;

  return {
    date,
    sqlDate: new Date(`${date}T00:00:00.000Z`),
  };
};

const formatProcedureSelection = (values) =>
  values.length > 0 ? `,${values.join(",")},` : "";

const executeStockMovement = async (
  poolConnection,
  { barcodes = [], designs = [] },
) => {
  const { date, sqlDate } = getToday();
  const request = poolConnection
    .request()
    .input("CompanyCode", sql.VarChar(6), "UR")
    .input("Branch", sql.NVarChar(sql.MAX), "")
    .input("Store", sql.NVarChar(sql.MAX), "")
    .input("Startdate", sql.DateTime, sqlDate)
    .input("DateFrom", sql.DateTime, sqlDate)
    .input("DateTo", sql.DateTime, sqlDate)
    .input(
      "Userid",
      sql.NVarChar(sql.MAX),
      "vbz4q4ebt4sqf1pe5wegmwk1",
    )
    .input("ReportType", sql.NVarChar(50), "7")
    .input("BranchOptions", sql.NVarChar(50), "0")
    .input("StoreOption", sql.NVarChar(50), "0")
    .input("ValuationMethod", sql.NVarChar(50), "4")
    .input("ReportName", sql.NVarChar(3), "004");

  EMPTY_STOCK_FILTERS.forEach((parameterName) => {
    request.input(parameterName, sql.NVarChar(sql.MAX), "");
  });

  const result = await request
    .input(
      "Barcode",
      sql.NVarChar(sql.MAX),
      formatProcedureSelection(barcodes),
    )
    .input(
      "Design",
      sql.NVarChar(sql.MAX),
      formatProcedureSelection(designs),
    )
    .input("IncludeZeroBal", sql.VarChar(1), "Y")
    .input("BarCodeFr", sql.NVarChar(sql.MAX), "")
    .input("BarCodeTo", sql.NVarChar(sql.MAX), "")
    .input("RetailFr", sql.Float, 0)
    .input("RetailTo", sql.Float, 0)
    .input("IsNonInventory", sql.NVarChar(1), "Y")
    .execute("POSStockMovement");

  return {
    date,
    records: result.recordset || [],
  };
};

/* ================= SEARCH PRODUCT ================= */
exports.searchProduct = async (req, res) => {
  try {
    const { q } = req.query;
    console.log("Search query received:", q);

    if (!q || q.trim() === "") {
      return res.json({ success: true, products: [] });
    }

    const rawValue = q.trim();
    const normalizedValue = normalize(rawValue);
    const likeValue = `%${rawValue}%`;

    console.log("Normalized:", normalizedValue);
    console.log("Like pattern:", likeValue);

    const poolConnection = await getPoolForTenant(req.user.tenantId);

    const result = await poolConnection
      .request()
      .input("rawValue", sql.VarChar, rawValue)
      .input("normalizedValue", sql.VarChar, normalizedValue)
      .input("likeValue", sql.VarChar, likeValue)
      .query(`
        SELECT *
        FROM BarcodeView
        WHERE 
          BarCode = @rawValue
          OR BarCode = @normalizedValue
          OR DesignNo = @rawValue
          OR DesignNo = @normalizedValue   -- ✅ Yeh line add karo
          OR DesignNo LIKE @likeValue
          OR DesignDesc LIKE @likeValue
        ORDER BY DesignNo, BarCode
      `);

    console.log("Records found:", result.recordset.length);

    return res.json({
      success: true,
      products: result.recordset || [],
    });

  } catch (err) {
    console.error("Product search error:", err);
    res.status(500).json({
      success: false,
      products: [],
      msg: err.message,
    });
  }
};

/* ================= SEARCH PRODUCT WITH CURRENT STOCK ================= */
exports.searchStock = async (req, res) => {
  try {
    const rawValue = String(req.query.q || "").trim();

    if (!rawValue) {
      return res.status(400).json({
        success: false,
        products: [],
        msg: "Barcode or design number is required",
      });
    }

    if (rawValue.length > 100 || rawValue.includes(",")) {
      return res.status(400).json({
        success: false,
        products: [],
        msg: "Invalid barcode or design number",
      });
    }

    const normalizedValue = normalize(rawValue);
    const poolConnection = await getPoolForTenant(req.user.tenantId);

    const productResult = await poolConnection
      .request()
      .input("rawValue", sql.NVarChar(100), rawValue)
      .input("normalizedValue", sql.NVarChar(100), normalizedValue)
      .query(`
        SELECT *
        FROM BarcodeView
        WHERE
          LTRIM(RTRIM(BarCode)) = @rawValue
          OR REPLACE(LTRIM(RTRIM(BarCode)), '-', '') = @normalizedValue
          OR LTRIM(RTRIM(DesignNo)) = @rawValue
          OR REPLACE(LTRIM(RTRIM(DesignNo)), '-', '') = @normalizedValue
        ORDER BY
          CASE
            WHEN LTRIM(RTRIM(BarCode)) = @rawValue THEN 0
            ELSE 1
          END,
          DesignNo,
          BarCode
      `);

    const products = productResult.recordset || [];

    if (products.length === 0) {
      return res.json({
        success: true,
        query: rawValue,
        products: [],
        overallStock: 0,
        totalBalQty: 0,
        stockSummary: {
          overallStock: 0,
          productCount: 0,
          procedureRowCount: 0,
        },
      });
    }

    const barcodes = [
      ...new Set(
        products
          .map((product) => String(product.BarCode || "").trim())
          .filter(Boolean),
      ),
    ];
    const searchType = products.some(
      (product) =>
        normalize(String(product.BarCode || "")) === normalizedValue,
    )
      ? "barcode"
      : "design";
    const designTransactionNumbers = [
      ...new Set(
        products
          .map((product) => String(product.TransactionNumber || "").trim())
          .filter(Boolean),
      ),
    ];

    if (searchType === "design" && designTransactionNumbers.length === 0) {
      return res.status(422).json({
        success: false,
        products: [],
        msg: "This design is missing its stock report mapping",
      });
    }

    // Barcode searches use @Barcode. DesignNo is first resolved to the
    // procedure's internal design/transaction number and then uses @Design;
    // this avoids sending 100+ barcodes and keeps the request below the
    // public gateway timeout.
    const { date, records } = await executeStockMovement(poolConnection, {
      barcodes: searchType === "barcode" ? barcodes : [],
      designs:
        searchType === "design" ? designTransactionNumbers : [],
    });

    const stockByBarcode = records.reduce((stockMap, row) => {
      const barcode = String(row.Barcode || row.BarCode || "").trim();

      if (barcode) {
        stockMap[barcode] =
          (stockMap[barcode] || 0) + Number(row.BalQty || 0);
      }

      return stockMap;
    }, {});

    const productsWithStock = products.map((product) => ({
      ...product,
      stock: stockByBarcode[String(product.BarCode || "").trim()] || 0,
    }));
    const totalBalQty = productsWithStock.reduce(
      (total, product) => total + Number(product.stock || 0),
      0,
    );

    return res.json({
      success: true,
      query: rawValue,
      searchType,
      date,
      products: productsWithStock,
      overallStock: totalBalQty,
      totalBalQty,
      stockSummary: {
        overallStock: totalBalQty,
        productCount: productsWithStock.length,
        procedureRowCount: records.length,
      },
    });
  } catch (err) {
    console.error("Stock search error:", err);

    return res.status(err.code === "ETIMEOUT" ? 504 : 500).json({
      success: false,
      products: [],
      msg:
        err.code === "ETIMEOUT"
          ? "Stock search timed out. Please try again."
          : "Unable to search stock right now",
    });
  }
};

/* ================= GET PRODUCT BY BARCODE ================= */
exports.getProductByBarcode = async (req, res) => {
  try {
    const { barcode } = req.params;

    if (!barcode) {
      return res.json({ success: true, product: null });
    }

    const normalizedValue = normalize(barcode);
    const poolConnection = await getPoolForTenant(req.user.tenantId);

    const result = await poolConnection
      .request()
      .input("normalizedValue", sql.VarChar, normalizedValue)
      .query(`
        SELECT TOP 1 *
        FROM BarcodeView
        WHERE REPLACE(BarCode, '-', '') = @normalizedValue
      `);

    return res.json({
      success: true,
      product: result.recordset[0] || null,
    });

  } catch (err) {
    console.error("Barcode fetch error:", err);
    res.status(500).json({
      success: false,
      product: null,
    });
  }
};

/* ================= STOCK REPORT ================= */
exports.getStockReport = async (req, res) => {
  try {
    const { barcode } = req.params;

    if (!barcode) {
      return res.status(400).json({
        success: false,
        msg: "Barcode required",
      });
    }

    const normalizedValue = normalize(barcode);
    const formattedBarcode = `,${normalizedValue},`;

    // Use the same Pakistan business date as the stock-search endpoint so
    // local development and Vercel return identical day boundaries.
    const { date: todayStr } = getToday();

    const poolConnection = await getPoolForTenant(req.user.tenantId);

    const stockResult = await poolConnection
      .request()
      .input("Barcode", sql.VarChar, formattedBarcode)
      .input("Date1", sql.VarChar, todayStr)
      .input("Date2", sql.VarChar, todayStr)
      .input("Date3", sql.VarChar, todayStr)
      .query(`
        EXEC POSStockMovement 
           'UR',
          '',
          '',
          @Date1,    -- pehli date
          @Date2,    -- doosri date
          @Date3,    -- teesri date
          'ikj13vfj2z31wpdydfe3g0sv',
          '7',
          '1',
          '0',
          '3',
          '004',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          '',
          @Barcode,
          '',
          'N',
          '',
          '',
          '0',
          '0',
		  'Y'
      `);

    const records = stockResult.recordset || [];

    const totalBalQty = records.reduce((sum, row) => {
      return sum + Number(row.BalQty || 0);
    }, 0);

    return res.json({
      success: true,
      stock: records,
      totalBalQty,
    });

  } catch (err) {
    console.error("Stock Report Error:", err);
    res.status(500).json({
      success: false,
      msg: "Server error",
    });
  }
};


// exports.getStockReport = async (req, res) => {
//   try {
//     const pool = await poolPromise;

//     const stockResult = await pool.request().query(`
//       EXEC POSStockMovement 
//       'LG',
//       '',
//       '',
//       '2021-07-01',
//       '2021-07-01',
//       '2026-02-19',
//       'ikj13vfj2z31wpdydfe3g0sv',
//       '7',
//       '1',
//       '0',
//       '3',
//       '004',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       '',
//       ',100120559,',
//       '',
//       'N',
//       '',
//       '',
//       '0',
//       '0'
//     `);

//     const records = stockResult.recordset || [];

//     console.log(records, "TEMP STOCK RESULT");

//     return res.json({
//       success: true,
//       stock: records
//     });

//   } catch (err) {
//     console.error("Stock Report Error:", err);
//     res.json({
//       success: false,
//       msg: err.message
//     });
//   }
// };
