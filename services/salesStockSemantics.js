const DIMENSIONS = Object.freeze({
  brand: { column: "BrandName", en: "brand", roman: "brand", urdu: "برانڈ", domains: ["sales", "stock"] },
  cobrand: { column: "CoBrandName", en: "co-brand", roman: "co brand", urdu: "کو برانڈ", domains: ["sales", "stock"] },
  supplier: { column: "SupplierName", en: "supplier", roman: "supplier", urdu: "سپلائر", domains: ["sales", "stock"] },
  category: { column: "CatagoryName", en: "category", roman: "category", urdu: "کیٹیگری", domains: ["sales", "stock"] },
  subcategory: { column: "SubCatagoryName", en: "sub-category", roman: "sub category", urdu: "سب کیٹیگری", domains: ["sales", "stock"] },
  style: { column: "StyleName", en: "style", roman: "style", urdu: "اسٹائل", domains: ["sales", "stock"] },
  substyle: { column: "SubStyleName", en: "sub-style", roman: "sub style", urdu: "سب اسٹائل", domains: ["sales", "stock"] },
  styleclass: { column: "StyleClassName", en: "style class", roman: "style class", urdu: "اسٹائل کلاس", domains: ["sales", "stock"] },
  substyleclass1: { column: "SubStyle1ClassName", en: "sub-style class 1", roman: "sub style class 1", urdu: "سب اسٹائل کلاس 1", domains: ["sales", "stock"] },
  substyleclass2: { column: "SubStyle2ClassName", en: "sub-style class 2", roman: "sub style class 2", urdu: "سب اسٹائل کلاس 2", domains: ["sales", "stock"] },
  department: { column: "DepartmentName", en: "department", roman: "department", urdu: "ڈپارٹمنٹ", domains: ["sales", "stock"] },
  subdepartment: { column: "SubDepartmentName", en: "sub-department", roman: "sub department", urdu: "سب ڈپارٹمنٹ", domains: ["sales", "stock"] },
  season: { column: "SeasonName", en: "season", roman: "season", urdu: "سیزن", domains: ["sales", "stock"] },
  fabric: { column: "FabricName", en: "fabric", roman: "fabric", urdu: "فیبرک", domains: ["sales", "stock"] },
  fabricclass: { column: "FabricClassName", en: "fabric class", roman: "fabric class", urdu: "فیبرک کلاس", domains: ["sales", "stock"] },
  color: { column: "ColorName", en: "colour", roman: "colour", urdu: "رنگ", domains: ["sales", "stock"] },
  colorclass: { column: "ColorClassName", en: "colour class", roman: "colour class", urdu: "رنگ کی کلاس", domains: ["sales", "stock"] },
  size: { column: "SizeName", en: "size", roman: "size", urdu: "سائز", domains: ["sales", "stock"] },
  designtype: { column: "DesignTypeName", en: "design type", roman: "design type", urdu: "ڈیزائن ٹائپ", domains: ["sales", "stock"] },
  gender: { column: "GenderName", en: "gender", roman: "gender", urdu: "جینڈر", domains: ["sales", "stock"] },
  design: { column: "DesignNo", en: "design", roman: "design", urdu: "ڈیزائن", domains: ["sales", "stock"] },
  barcode: { column: "BarCode", en: "barcode", roman: "barcode", urdu: "بارکوڈ", domains: ["sales", "stock"] },
  branch: { column: "BranchName", en: "branch", roman: "branch", urdu: "برانچ", domains: ["sales", "stock"] },
  store: { column: "StoreName", en: "store", roman: "store", urdu: "اسٹور", domains: ["stock"] },
  salesman: { column: "SalesmanName", en: "salesman", roman: "salesman", urdu: "سیلز مین", domains: ["sales"] },
  bill: { column: "BillKey", en: "bill", roman: "bill", urdu: "بل", domains: ["sales"] },
});

const METRICS = Object.freeze({
  sales: ["net sales", "net quantity", "gross profit", "gross margin", "discount", "returns", "bill count", "average bill value"],
  stock: ["current stock", "stock value", "opening stock", "purchases", "sales movement", "transfers", "in-transit stock", "days cover", "dead stock"],
});

const BUSINESS_RULES = Object.freeze([
  "Sales amounts and quantities retain signed returns.",
  "Gross profit is transaction NetAmount minus historical CostAmountofSales; it is not accounting net profit.",
  "Bill count uses distinct BillKey, never line count.",
  "StockQty and StockValue are saved procedure balances and must be summed, not reconstructed.",
  "Stock movement belongs to the disclosed snapshot period; it is not arbitrary historical stock.",
  "Sales and stock must be aggregated to the same branch/barcode grain before they are joined.",
  "Unknown or unrecorded facts stay unavailable; the assistant must not guess them.",
]);

module.exports = { DIMENSIONS, METRICS, BUSINESS_RULES };
