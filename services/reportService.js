const { sql, getPoolForTenant } = require("../config/db");
const aiConfig = require("../config/ai");
const reportCatalog = require("../ai/reportCatalog");

const dimensionMap = {
  day: { label: "Period", select: "CONVERT(varchar(10), s.SaleDate, 23)", join: "", fallback: "" },
  week: { label: "Week", select: "CONCAT(DATEPART(year,s.SaleDate),'-W',RIGHT('0'+CAST(DATEPART(iso_week,s.SaleDate) AS varchar(2)),2))", join: "", fallback: "" },
  month: { label: "Month", select: "CONVERT(varchar(7), s.SaleDate, 23)", join: "", fallback: "" },
  branch: { label: "Branch", select: "COALESCE(bf.BranchName, s.Branch)", join: "LEFT JOIN BranchFile bf ON bf.BranchCode=s.Branch", fallback: "Unassigned" },
  store: { label: "Store", select: "COALESCE(sr.Name, s.StoreCode)", join: "LEFT JOIN StockRoom sr ON sr.Code=s.StoreCode", fallback: "Unassigned" },
  barcode: { label: "Product", select: "COALESCE(NULLIF(bv.DesignDesc,''), s.BarCode)", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  design: { label: "Design", select: "COALESCE(NULLIF(bv.DesignDesc,''),NULLIF(bv.DesignNo,''),s.BarCode)", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  brand: { label: "Brand", select: "COALESCE(NULLIF(bv.BrandName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  cobrand: { label: "Co-Brand", select: "COALESCE(NULLIF(bv.CoBrandName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  category: { label: "Category", select: "COALESCE(NULLIF(bv.CatagoryName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  subcategory: { label: "Sub Category", select: "COALESCE(NULLIF(bv.SubCatagoryName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  department: { label: "Department", select: "COALESCE(NULLIF(bv.DepartmentName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  subdepartment: { label: "Sub Department", select: "COALESCE(NULLIF(bv.SubDepartmentName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  style: { label: "Style", select: "COALESCE(NULLIF(bv.StyleName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  season: { label: "Season", select: "COALESCE(NULLIF(bv.SeasonName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  fabric: { label: "Fabric", select: "COALESCE(NULLIF(bv.FabricName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  gender: { label: "Gender", select: "COALESCE(NULLIF(bv.GenderName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  size: { label: "Size", select: "COALESCE(NULLIF(bv.SizeName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  color: { label: "Color", select: "COALESCE(NULLIF(bv.ColorName,''), 'Unassigned')", join: "LEFT JOIN BarcodeView bv ON bv.BarCode=s.BarCode", fallback: "Unassigned" },
  salesman: { label: "Salesman", select: "COALESCE(NULLIF(e.Name,''), s.SalesMan)", join: "LEFT JOIN Employee e ON e.Code=s.SalesMan", fallback: "Unassigned" },
};

function businessDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeDate(value, fallback) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

function normalizeList(value, max = 50) {
  const source = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))].slice(0, max);
}

function normalizeFilters(input = {}) {
  const today = businessDate();
  const thisMonth = `${today.slice(0, 8)}01`;
  let fromDate = normalizeDate(input.fromDate, thisMonth);
  let toDate = normalizeDate(input.toDate, today);
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  const listKeys = ["accounts","brands","categories","seasons","styles","colors","sizes","designs","fabrics","departments","genders","cobrands","suppliers","subcategories","substyles","styleclasses","styleclass1","styleclass2","subdepartments","fabricclasses","colorclasses"];
  const normalized = {
    fromDate, toDate,
    branches: normalizeList(input.branches || input.branch),
    stores: normalizeList(input.stores || input.store),
    barcodes: normalizeList(input.barcodes || input.barcode, 100),
    accounts: normalizeList(input.accounts || input.account),
  };
  for (const key of listKeys) normalized[key] = normalizeList(input[key] || input[key.replace(/s$/, "")]);
  return normalized;
}

const productFilterMap = {
  brands:"Brand",categories:"Catagory",seasons:"Season",styles:"Style",colors:"Color",sizes:"Size",
  designs:"DesignNo",fabrics:"Fabric",departments:"Department",genders:"Gender",cobrands:"CoBrand",
  suppliers:"CoBrandClass",subcategories:"SubCatagory",substyles:"SubStyle",styleclasses:"StyleClass",
  styleclass1:"SubStyle1Class",styleclass2:"SubStyle2Class",subdepartments:"SubDepartment",
  fabricclasses:"FabricClass",colorclasses:"ColorClass",
};

function addProductFilters(request, clauses, alias, filters, prefix="product") {
  for (const [filterKey, column] of Object.entries(productFilterMap)) {
    addListFilter(request, clauses, `${alias}.${column}`, `${prefix}${filterKey}`, filters[filterKey] || []);
  }
}

function addListFilter(request, clauses, expression, prefix, values, type = sql.NVarChar) {
  if (!values.length) return;
  const params = values.map((value, index) => {
    const name = `${prefix}${index}`;
    request.input(name, type, value);
    return `@${name}`;
  });
  clauses.push(`${expression} IN (${params.join(",")})`);
}

function createRequest(pool, user, filters) {
  const request = pool.request();
  request.timeout = aiConfig.sqlTimeoutMs;
  request.input("companyCode", sql.VarChar(20), String(user.companyCode || ""));
  request.input("fromDate", sql.Date, filters.fromDate);
  request.input("toDate", sql.Date, filters.toDate);
  return request;
}

function salesCte(request, filters) {
  const outer = [];
  addListFilter(request, outer, "s.Branch", "branch", filters.branches);
  addListFilter(request, outer, "s.StoreCode", "store", filters.stores);
  addListFilter(request, outer, "s.BarCode", "barcode", filters.barcodes);
  const accountFilters=[];addListFilter(request,accountFilters,"p.ActCod","salesAccount",filters.accounts);
  if(accountFilters.length) outer.push(`(EXISTS (SELECT 1 FROM PosPayment p WHERE p.CompanyCode=@companyCode AND p.Branch=s.Branch AND p.TransactionNumber=s.TransactionNumber AND ${accountFilters.join(" AND ")}) OR EXISTS (SELECT 1 FROM UnPosPayment p WHERE p.CompanyCode=@companyCode AND p.Branch=s.Branch AND p.TransactionNumber=s.TransactionNumber AND ${accountFilters.join(" AND ")}))`);
  const productFilters = [];
  addProductFilters(request, productFilters, "bvFilter", filters, "salesProduct");
  if (productFilters.length) {
    outer.push(`EXISTS (SELECT 1 FROM BarcodeView bvFilter WHERE bvFilter.BarCode=s.BarCode AND ${productFilters.join(" AND ")})`);
  }
  const where = outer.length ? `WHERE ${outer.join(" AND ")}` : "";
  const net = "ISNULL(d.Amount,0)-ISNULL(d.DiscAutoAmt,0)-ISNULL(d.DiscManualAmt,0)-ISNULL(d.DetSchemeDisc,0)-ISNULL(d.DetLoyalityDisc,0)-ISNULL(d.DetBillDiscAmt,0)-ISNULL(d.DetRoundingAmt,0)";
  return `
    WITH SalesBase AS (
      SELECT d.TranDate SaleDate,d.Branch,d.StoreCode,d.BarCode,d.SalesManAccount SalesMan,
        ISNULL(d.Quantity,0) Qty,ISNULL(d.Amount,0) GrossSales,(${net}) NetSales,
        ISNULL(d.DiscAutoAmt,0)+ISNULL(d.DiscManualAmt,0)+ISNULL(d.DetSchemeDisc,0)+ISNULL(d.DetLoyalityDisc,0)+ISNULL(d.DetBillDiscAmt,0)+ISNULL(d.DetRoundingAmt,0) DiscountAmount,
        ISNULL(d.TaxAmt,0) GST,ISNULL(d.TaxableAmt,0) TaxableAmount,ISNULL(d.PurchasePrice,0)*ISNULL(d.Quantity,0) CostValue,
        d.DetFBRInvNo,d.DetFBRId,d.TransactionNumber
      FROM PosDetail d
      INNER JOIN PosMaster m ON m.CompanyCode=d.CompanyCode AND m.Branch=d.Branch AND m.TransactionNumber=d.TransactionNumber
      WHERE d.CompanyCode=@companyCode AND m.BillStatus='P' AND ISNULL(d.Cancel,'N')<>'Y'
        AND d.TranDate>=@fromDate AND d.TranDate<DATEADD(day,1,@toDate)
      UNION ALL
      SELECT d.TranDate,d.Branch,d.StoreCode,d.BarCode,d.SalesManAccount,
        ISNULL(d.Quantity,0),ISNULL(d.Amount,0),(${net}),
        ISNULL(d.DiscAutoAmt,0)+ISNULL(d.DiscManualAmt,0)+ISNULL(d.DetSchemeDisc,0)+ISNULL(d.DetLoyalityDisc,0)+ISNULL(d.DetBillDiscAmt,0)+ISNULL(d.DetRoundingAmt,0),
        ISNULL(d.TaxAmt,0),ISNULL(d.TaxableAmt,0),ISNULL(d.PurchasePrice,0)*ISNULL(d.Quantity,0),d.DetFBRInvNo,d.DetFBRId,d.TransactionNumber
      FROM UnPosDetail d
      INNER JOIN UnPosMaster m ON m.CompanyCode=d.CompanyCode AND m.Branch=d.Branch AND m.TransactionNumber=d.TransactionNumber
      WHERE d.CompanyCode=@companyCode AND m.BillStatus='P' AND ISNULL(d.Cancel,'N')<>'Y'
        AND d.TranDate>=@fromDate AND d.TranDate<DATEADD(day,1,@toDate)
        AND NOT EXISTS (
          SELECT 1 FROM PosMaster pm WHERE pm.CompanyCode=d.CompanyCode AND pm.Branch=d.Branch
            AND pm.TransactionNumber=d.TransactionNumber AND pm.BillStatus='P'
        )
    ), Sales AS (SELECT s.* FROM SalesBase s ${where})`;
}

function toKpis(row, definitions) {
  return definitions.map(([key, label, format = "number"]) => ({
    key, label, format, value: Number(row?.[key] || 0),
  }));
}

async function runSalesSummary(pool, user, filters) {
  const request = createRequest(pool, user, filters);
  const cte = salesCte(request, filters);
  const result = await request.query(`${cte}, Daily AS (
      SELECT CONVERT(varchar(10),SaleDate,23) Label,SUM(GrossSales) GrossSales,SUM(NetSales) Amount,
        SUM(Qty) Quantity,SUM(DiscountAmount) DiscountAmount,SUM(GST) GST,
        SUM(NetSales-CostValue) GrossProfit,COUNT(DISTINCT TransactionNumber) BillCount
      FROM Sales GROUP BY CONVERT(varchar(10),SaleDate,23)
    ) SELECT Label,Amount,Quantity,
      SUM(GrossSales) OVER() TotalGrossSales,SUM(Amount) OVER() NetSales,SUM(Quantity) OVER() NetQty,
      SUM(DiscountAmount) OVER() TotalDiscount,SUM(GST) OVER() TotalGST,SUM(GrossProfit) OVER() TotalGrossProfit,
      CASE WHEN SUM(Amount) OVER()=0 THEN 0 ELSE SUM(GrossProfit) OVER()*100.0/SUM(Amount) OVER() END MarginPercent,
      SUM(BillCount) OVER() TotalBillCount
    FROM Daily ORDER BY Label;`);
  const rows = result.recordset || [];
  const first = rows[0] || {};
  const summary = { NetSales:first.NetSales,NetQty:first.NetQty,GrossProfit:first.TotalGrossProfit,
    MarginPercent:first.MarginPercent,DiscountAmount:first.TotalDiscount,BillCount:first.TotalBillCount };
  return {
    title: "Sales Summary",
    kpis: toKpis(summary, [["NetSales","Net Sales","currency"],["NetQty","Net Quantity"],["GrossProfit","Gross Profit","currency"],["MarginPercent","Margin %","percent"],["DiscountAmount","Discount","currency"],["BillCount","Paid Bills"]]),
    charts: [{ type: "line", title: "Daily Sales & Quantity", data: rows }],
    rows,
  };
}

async function runSalesDimension(pool, user, filters, dimension) {
  const dim = dimensionMap[dimension] || dimensionMap.branch;
  const request = createRequest(pool, user, filters);
  const cte = salesCte(request, filters);
  const result = await request.query(`${cte}
    SELECT TOP 100 ${dim.select} Label,SUM(s.NetSales) Amount,SUM(s.Qty) Quantity,
      SUM(s.NetSales-s.CostValue) GrossProfit,
      CASE WHEN SUM(s.NetSales)=0 THEN 0 ELSE SUM(s.NetSales-s.CostValue)*100.0/SUM(s.NetSales) END MarginPercent,
      SUM(SUM(s.NetSales)) OVER() OverallAmount,SUM(SUM(s.Qty)) OVER() OverallQuantity
    FROM Sales s ${dim.join}
    GROUP BY ${dim.select}
    ORDER BY Amount DESC;`);
  const rows = result.recordset || [];
  return {
    title: `${dim.label} Wise Sales`,
    kpis: toKpis({NetSales:rows[0]?.OverallAmount,NetQty:rows[0]?.OverallQuantity}, [["NetSales","Net Sales","currency"],["NetQty","Net Quantity"]]),
    charts: [{ type: dimension === "day" ? "line" : "bar", title: `${dim.label} Performance`, data: rows.slice(0, 20) }],
    rows,
  };
}

function purchaseCte(request, filters, isReturn = false) {
  const master = isReturn ? "PosPReturnM" : "PosPurchaseM";
  const detail = isReturn ? "PosPReturnD" : "PosPurchaseD";
  const clauses = [];
  addListFilter(request, clauses, "d.Branch", "branch", filters.branches);
  addListFilter(request, clauses, "d.StoreCode", "store", filters.stores);
  addListFilter(request, clauses, "d.BarCode", "barcode", filters.barcodes);
  addListFilter(request, clauses, "m.PartyCode", "account", filters.accounts);
  const productFilters=[];addProductFilters(request,productFilters,"bvFilter",filters,"purchaseProduct");
  if(productFilters.length) clauses.push(`EXISTS (SELECT 1 FROM BarcodeView bvFilter WHERE bvFilter.BarCode=d.BarCode AND ${productFilters.join(" AND ")})`);
  const extra = clauses.length ? `AND ${clauses.join(" AND ")}` : "";
  return `WITH Purchase AS (
    SELECT m.Date TransactionDate,d.Branch,d.StoreCode,d.BarCode,m.PartyCode,
      ISNULL(d.Quantity,0) Quantity,ISNULL(d.DetBillAmount,ISNULL(d.ValueIncludingST,0)) Amount
    FROM ${detail} d INNER JOIN ${master} m
      ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber
    WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y'
      AND m.Date>=@fromDate AND m.Date<DATEADD(day,1,@toDate) ${extra}
  )`;
}

async function runPurchase(pool, user, filters, { isReturn = false, dimension = null } = {}) {
  const request = createRequest(pool, user, filters);
  const cte = purchaseCte(request, filters, isReturn);
  let dimensionSql = null;
  if (dimension === "supplier") dimensionSql = { label:"COALESCE(a.AcName,p.PartyCode)", from:"Purchase p LEFT JOIN AccountList a ON a.ActCod=p.PartyCode" };
  else if(dimensionMap[dimension]&&dimension!=="salesman"){
    const dim=dimensionMap[dimension];dimensionSql={label:dim.select.replace(/\bs\./g,"p.").replace(/SaleDate/g,"TransactionDate"),from:`Purchase p ${dim.join.replace(/\bs\./g,"p.")}`};
  }
  const query = dimensionSql
    ? `${cte} SELECT TOP 100 ${dimensionSql.label} Label,SUM(p.Amount) Amount,SUM(p.Quantity) Quantity,
         SUM(SUM(p.Amount)) OVER() OverallAmount,SUM(SUM(p.Quantity)) OVER() OverallQuantity
       FROM ${dimensionSql.from} GROUP BY ${dimensionSql.label} ORDER BY Amount DESC;`
    : `${cte}, Daily AS (SELECT CONVERT(varchar(10),TransactionDate,23) Label,SUM(Amount) Amount,SUM(Quantity) Quantity FROM Purchase GROUP BY CONVERT(varchar(10),TransactionDate,23))
       SELECT TOP 40 Label,Amount,Quantity,SUM(Amount) OVER() TotalAmount,SUM(Quantity) OVER() TotalQuantity FROM Daily ORDER BY Label;`;
  const result = await request.query(query);
  const rows = result.recordset || [];
  const summary = dimensionSql
    ? { Amount:rows[0]?.OverallAmount, Quantity:rows[0]?.OverallQuantity }
    : { Amount: rows[0]?.TotalAmount, Quantity: rows[0]?.TotalQuantity };
  const prefix = isReturn ? "Purchase Return" : "Purchase";
  return {
    title: dimension ? `${dimension[0].toUpperCase()+dimension.slice(1)} Wise ${prefix}` : `${prefix} Summary`,
    kpis: toKpis(summary, [["Amount",`${prefix} Amount`,"currency"],["Quantity",`${prefix} Quantity`],["ProductCount","Products"]]),
    charts: [{ type: dimension ? "bar" : "line", title: `${prefix} Analysis`, data: rows.slice(0, 20) }], rows,
  };
}

async function runPayment(pool, user, filters) {
  const request = createRequest(pool, user, filters);
  const paymentClauses=[];addListFilter(request,paymentClauses,"p.Branch","paymentBranch",filters.branches);addListFilter(request,paymentClauses,"p.ActCod","paymentAccount",filters.accounts);const paymentScope=paymentClauses.length?`AND ${paymentClauses.join(" AND ")}`:"";
  const detailClauses=[];addListFilter(request,detailClauses,"sd.StoreCode","paymentStore",filters.stores);addListFilter(request,detailClauses,"sd.BarCode","paymentBarcode",filters.barcodes);const productFilters=[];addProductFilters(request,productFilters,"bvFilter",filters,"paymentProduct");if(productFilters.length)detailClauses.push(`EXISTS (SELECT 1 FROM BarcodeView bvFilter WHERE bvFilter.BarCode=sd.BarCode AND ${productFilters.join(" AND ")})`);const detailScope=(table)=>detailClauses.length?`AND EXISTS (SELECT 1 FROM ${table} sd WHERE sd.CompanyCode=p.CompanyCode AND sd.Branch=p.Branch AND sd.TransactionNumber=p.TransactionNumber AND ${detailClauses.join(" AND ")})`:"";
  const result = await request.query(`WITH Payments AS (
    SELECT p.Paymethod,ISNULL(p.Amount,0) Amount FROM PosPayment p INNER JOIN PosMaster m
      ON m.CompanyCode=p.CompanyCode AND m.Branch=p.Branch AND m.TransactionNumber=p.TransactionNumber
      WHERE p.CompanyCode=@companyCode AND m.BillStatus='P' AND ISNULL(p.Cancel,'N')<>'Y' AND p.TranDate>=@fromDate AND p.TranDate<DATEADD(day,1,@toDate) ${paymentScope} ${detailScope("PosDetail")}
    UNION ALL
    SELECT p.Paymethod,ISNULL(p.Amount,0) FROM UnPosPayment p INNER JOIN UnPosMaster m
      ON m.CompanyCode=p.CompanyCode AND m.Branch=p.Branch AND m.TransactionNumber=p.TransactionNumber
      WHERE p.CompanyCode=@companyCode AND m.BillStatus='P' AND ISNULL(p.Cancel,'N')<>'Y' AND p.TranDate>=@fromDate AND p.TranDate<DATEADD(day,1,@toDate) ${paymentScope} ${detailScope("UnPosDetail")}
      AND NOT EXISTS (SELECT 1 FROM PosMaster pm WHERE pm.CompanyCode=p.CompanyCode AND pm.Branch=p.Branch AND pm.TransactionNumber=p.TransactionNumber AND pm.BillStatus='P')
  ) SELECT CASE Paymethod WHEN '1' THEN 'Cash' WHEN '2' THEN 'Card' WHEN '3' THEN 'Credit' ELSE 'Other' END Label,SUM(Amount) Amount FROM Payments GROUP BY Paymethod ORDER BY Amount DESC;`);
  const rows = result.recordset || [];
  const total = rows.reduce((sum, row) => sum + Number(row.Amount || 0), 0);
  return { title: "Payment Mix", kpis: [{ key:"Total",label:"Total Paid",format:"currency",value:total }], charts:[{type:"pie",title:"Cash / Card / Credit",data:rows}], rows };
}

async function runTransfer(pool, user, filters) {
  const request = createRequest(pool, user, filters);
  const clauses=[]; addListFilter(request,clauses,"d.Branch","branch",filters.branches); addListFilter(request,clauses,"d.StoreCodeFrom","store",filters.stores); addListFilter(request,clauses,"d.BarCode","barcode",filters.barcodes);
  const productFilters=[];addProductFilters(request,productFilters,"bvFilter",filters,"transferProduct");
  if(productFilters.length) clauses.push(`EXISTS (SELECT 1 FROM BarcodeView bvFilter WHERE bvFilter.BarCode=d.BarCode AND ${productFilters.join(" AND ")})`);
  const extra=clauses.length?`AND ${clauses.join(" AND ")}`:"";
  const result=await request.query(`SELECT COALESCE(b1.BranchName,d.Branch)+' to '+COALESCE(b2.BranchName,d.Branchto) Label,
    SUM(ISNULL(d.Quantity,0)) SentQuantity,SUM(CASE WHEN d.RecStatus='Y' THEN ISNULL(d.RecQuantity,0) ELSE 0 END) ReceivedQuantity,
    SUM(ISNULL(d.Quantity,0)-CASE WHEN d.RecStatus='Y' THEN ISNULL(d.RecQuantity,0) ELSE 0 END) PendingQuantity
    FROM PosTransferD d INNER JOIN PosTransferM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber
    LEFT JOIN BranchFile b1 ON b1.BranchCode=d.Branch LEFT JOIN BranchFile b2 ON b2.BranchCode=d.Branchto
    WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y'
      AND m.TransactionDate>=@fromDate AND m.TransactionDate<DATEADD(day,1,@toDate) ${extra}
    GROUP BY COALESCE(b1.BranchName,d.Branch)+' to '+COALESCE(b2.BranchName,d.Branchto) ORDER BY SentQuantity DESC;`);
  const rows=result.recordset||[]; const summary=rows.reduce((a,x)=>({Sent:a.Sent+Number(x.SentQuantity||0),Received:a.Received+Number(x.ReceivedQuantity||0),Pending:a.Pending+Number(x.PendingQuantity||0)}),{Sent:0,Received:0,Pending:0});
  return {title:"Transfer Sent vs Received",kpis:toKpis(summary,[["Sent","Sent Quantity"],["Received","Received Quantity"],["Pending","In Transit"]]),charts:[{type:"bar",title:"Transfer Routes",data:rows.slice(0,20)}],rows};
}

async function runSimpleInventory(pool,user,filters,type){
  const request=createRequest(pool,user,filters); const isTake=type==="take"; const master=isTake?"PosStockTakeM":"PosStockAdjM"; const detail=isTake?"PosStockTakeD":"PosStockAdjD";const clauses=[];
  addListFilter(request,clauses,"d.Branch","simpleBranch",filters.branches);addListFilter(request,clauses,"d.StoreCode","simpleStore",filters.stores);addListFilter(request,clauses,"d.BarCode","simpleBarcode",filters.barcodes);const productFilters=[];addProductFilters(request,productFilters,"bvFilter",filters,"simpleProduct");if(productFilters.length)clauses.push(`EXISTS (SELECT 1 FROM BarcodeView bvFilter WHERE bvFilter.BarCode=d.BarCode AND ${productFilters.join(" AND ")})`);const scope=clauses.length?`AND ${clauses.join(" AND ")}`:"";
  const groupClause=isTake?"":"GROUP BY ISNULL(d.EntryType,'Unknown')";
  const result=await request.query(`SELECT ${isTake?"'Physical Count'":"ISNULL(d.EntryType,'Unknown')"} Label,SUM(ISNULL(d.Quantity,0)) Quantity,
    SUM(ISNULL(d.RetailAmount,0)) Amount FROM ${detail} d INNER JOIN ${master} m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber
    WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y'
      AND m.TransactionDate>=@fromDate AND m.TransactionDate<DATEADD(day,1,@toDate) ${scope}
    ${groupClause};`);
  const rows=result.recordset||[]; const total=rows.reduce((s,x)=>s+Number(x.Quantity||0),0);
  return {title:isTake?"Physical Stock Take (Checking Only)":"Stock Adjustment",kpis:[{key:"Quantity",label:isTake?"Physical Quantity":"Adjustment Quantity",format:"number",value:total}],charts:[{type:"bar",title:isTake?"Physical Count":"IN / OUT",data:rows}],rows,note:isTake?"Stock Take does not directly change system stock.":undefined};
}

async function runStock(pool,user,filters,dimension=null){
  const request=createRequest(pool,user,filters); const clauses=[]; addListFilter(request,clauses,"x.Branch","branch",filters.branches); addListFilter(request,clauses,"x.StoreCode","store",filters.stores); addListFilter(request,clauses,"x.BarCode","barcode",filters.barcodes);
  const productFilters=[];addProductFilters(request,productFilters,"bvFilter",filters,"stockProduct");
  if(productFilters.length) clauses.push(`EXISTS (SELECT 1 FROM BarcodeView bvFilter WHERE bvFilter.BarCode=x.BarCode AND ${productFilters.join(" AND ")})`);
  const extra=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
  const stockDimension=dimensionMap[dimension]&&!['day','week','month','salesman'].includes(dimension)?dimensionMap[dimension]:null;
  const dimensionLabel=stockDimension?stockDimension.select.replace(/\bs\./g,"f."):null;
  const result=await request.query(`WITH Movements AS (
    SELECT Branch,StoreCode,BarCode,ISNULL(Quantity,0) Qty FROM PosBarOpen WHERE CompanyCode=@companyCode
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,ISNULL(d.Quantity,0) FROM PosPurchaseD d INNER JOIN PosPurchaseM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND m.Date<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,-ISNULL(d.Quantity,0) FROM PosPReturnD d INNER JOIN PosPReturnM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND m.Date<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,-ISNULL(d.Quantity,0) FROM PosDetail d INNER JOIN PosMaster m ON m.CompanyCode=d.CompanyCode AND m.Branch=d.Branch AND m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode AND m.BillStatus='P' AND ISNULL(d.Cancel,'N')<>'Y' AND d.TranDate<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,-ISNULL(d.Quantity,0) FROM UnPosDetail d INNER JOIN UnPosMaster m ON m.CompanyCode=d.CompanyCode AND m.Branch=d.Branch AND m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode AND m.BillStatus='P' AND ISNULL(d.Cancel,'N')<>'Y' AND d.TranDate<DATEADD(day,1,@toDate) AND NOT EXISTS(SELECT 1 FROM PosMaster pm WHERE pm.CompanyCode=d.CompanyCode AND pm.Branch=d.Branch AND pm.TransactionNumber=d.TransactionNumber AND pm.BillStatus='P')
    UNION ALL SELECT d.Branch,d.StoreCodeFrom,d.BarCode,-ISNULL(d.Quantity,0) FROM PosTransferD d INNER JOIN PosTransferM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND m.TransactionDate<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branchto,d.StoreCodeTo,d.BarCode,ISNULL(d.RecQuantity,0) FROM PosTransferD d INNER JOIN PosTransferM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode AND d.RecStatus='Y' AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND d.RecDate<DATEADD(day,1,@toDate)
    UNION ALL SELECT d.Branch,d.StoreCode,d.BarCode,CASE WHEN d.EntryType='IN' THEN ISNULL(d.Quantity,0) WHEN d.EntryType='OUT' THEN -ISNULL(d.Quantity,0) ELSE 0 END FROM PosStockAdjD d INNER JOIN PosStockAdjM m ON m.CompanyCode=d.CompanyCode AND m.TransactionNumber=d.TransactionNumber WHERE d.CompanyCode=@companyCode AND ISNULL(d.Cancel,'N')<>'Y' AND ISNULL(m.Cancel,'N')<>'Y' AND m.TransactionDate<DATEADD(day,1,@toDate)
  ), Filtered AS (SELECT x.* FROM Movements x ${extra})
  ${stockDimension?`SELECT TOP 100 ${dimensionLabel} Label,MIN(f.BarCode) BarCode,SUM(f.Qty) Quantity,`:`SELECT TOP 100 COALESCE(NULLIF(bv.DesignDesc,''),f.BarCode) Label,f.BarCode,COALESCE(bf.BranchName,f.Branch) BranchName,COALESCE(sr.Name,f.StoreCode) StoreName,SUM(f.Qty) Quantity,`}
    SUM(f.Qty*ISNULL(bv.CostPrice,0)) CostValue,SUM(f.Qty*ISNULL(bv.PurchasePrice,0)) PurchaseValue,SUM(f.Qty*ISNULL(bv.RetailPrice,0)) RetailValue,SUM(f.Qty*ISNULL(bv.DiscountPrice,0)) DiscountValue,
    SUM(SUM(f.Qty)) OVER() OverallQuantity,SUM(SUM(f.Qty*ISNULL(bv.CostPrice,0))) OVER() OverallCostValue,SUM(SUM(f.Qty*ISNULL(bv.RetailPrice,0))) OVER() OverallRetailValue
    FROM Filtered f LEFT JOIN BarcodeView bv ON bv.BarCode=f.BarCode LEFT JOIN BranchFile bf ON bf.BranchCode=f.Branch LEFT JOIN StockRoom sr ON sr.Code=f.StoreCode
    GROUP BY ${stockDimension?dimensionLabel:"COALESCE(NULLIF(bv.DesignDesc,''),f.BarCode),f.BarCode,COALESCE(bf.BranchName,f.Branch),COALESCE(sr.Name,f.StoreCode)"}
    HAVING SUM(f.Qty)<>0 ORDER BY ABS(SUM(f.Qty)) DESC;`);
  const rows=result.recordset||[]; const total=Number(rows[0]?.OverallQuantity||0);
  return {title:"Current Stock",kpis:[{key:"Quantity",label:"Current Stock",format:"number",value:total},{key:"CostValue",label:"Stock Value at Cost",format:"currency",value:Number(rows[0]?.OverallCostValue||0)},{key:"RetailValue",label:"Potential Retail Value",format:"currency",value:Number(rows[0]?.OverallRetailValue||0)}],charts:[{type:"bar",title:"Stock by Product / Location",data:rows.slice(0,20)}],rows,note:"Overall stock and valuation use the full selected scope; only the leading 100 rows are displayed."};
}

async function runDiscount(pool,user,filters){
  const request=createRequest(pool,user,filters); const clauses=[]; addListFilter(request,clauses,"d.Barcode","barcode",filters.barcodes); addListFilter(request,clauses,"d.Branch","branch",filters.branches);
  const productFilters=[];addProductFilters(request,productFilters,"bvFilter",filters,"discountProduct");if(productFilters.length)clauses.push(`EXISTS (SELECT 1 FROM BarcodeView bvFilter WHERE bvFilter.BarCode=d.Barcode AND ${productFilters.join(" AND ")})`);
  const extraScope=clauses.length?`AND ${clauses.join(" AND ")}`:"";
  const result=await request.query(`SELECT TOP 200 COALESCE(NULLIF(bv.DesignDesc,''),d.Barcode) Label,d.TransactionNumber,d.DisPolicy,d.DisPercent,d.DisFrom,d.DisTo,d.DisBranch,d.Barcode,COUNT(*) OVER() TotalPolicies FROM PosDiscount d LEFT JOIN BarcodeView bv ON bv.BarCode=d.Barcode WHERE d.CompanyCode=@companyCode AND d.Status='Y' AND d.DisFrom<=@toDate AND d.DisTo>=@fromDate ${extraScope} ORDER BY d.TransactionDate DESC;`);
  const rows=result.recordset||[]; return {title:"Active Discount Policies",kpis:[{key:"Policies",label:"Active Policies",format:"number",value:Number(rows[0]?.TotalPolicies||0)}],charts:[{type:"bar",title:"Discount Percent",data:rows.slice(0,20).map(x=>({Label:x.Label,Amount:Number(x.DisPercent||0)}))}],rows};
}

async function runFbr(pool,user,filters){
  const request=createRequest(pool,user,filters); const cte=salesCte(request,filters);
  const result=await request.query(`${cte} SELECT CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(s.DetFBRInvNo,''))),'') IS NULL THEN 'Without FBR Invoice' ELSE 'FBR Invoiced' END Label,SUM(s.NetSales) Amount,SUM(s.Qty) Quantity,SUM(s.TaxableAmount) TaxableAmount,SUM(s.GST) GST FROM Sales s GROUP BY CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(s.DetFBRInvNo,''))),'') IS NULL THEN 'Without FBR Invoice' ELSE 'FBR Invoiced' END ORDER BY Amount DESC;`);
  const rows=result.recordset||[]; const summary=rows.reduce((a,x)=>({Amount:a.Amount+Number(x.Amount||0),Quantity:a.Quantity+Number(x.Quantity||0),TaxableAmount:a.TaxableAmount+Number(x.TaxableAmount||0),GST:a.GST+Number(x.GST||0)}),{Amount:0,Quantity:0,TaxableAmount:0,GST:0});
  return {title:"FBR / GST Sales Summary",kpis:toKpis(summary,[["Amount","Net Sales","currency"],["Quantity","Quantity"],["TaxableAmount","Taxable Amount","currency"],["GST","GST","currency"]]),charts:[{type:"bar",title:"FBR Invoice Coverage",data:rows.slice(0,20)}],rows};
}

async function runProductMaster(pool,user,filters){
  const request=createRequest(pool,user,filters);const clauses=[];addListFilter(request,clauses,"bv.BarCode","masterBarcode",filters.barcodes);addProductFilters(request,clauses,"bv",filters,"masterProduct");const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
  const result=await request.query(`SELECT TOP 200 bv.BarCode,bv.DesignNo,bv.DesignDesc,bv.BrandName,bv.CatagoryName,bv.SubCatagoryName,bv.StyleName,bv.SeasonName,bv.ColorName,bv.SizeName,bv.FabricName,bv.DepartmentName,bv.GenderName,bv.CoBrandName,bv.PurchasePrice,bv.RetailPrice,bv.DiscountPrice,COUNT(*) OVER() TotalProducts FROM BarcodeView bv ${where} ORDER BY bv.DesignDesc,bv.BarCode`);
  const rows=result.recordset||[];const brandCounts=new Map();for(const row of rows)brandCounts.set(row.BrandName||"Unassigned",(brandCounts.get(row.BrandName||"Unassigned")||0)+1);
  const chartRows=[...brandCounts].map(([Label,Quantity])=>({Label,Quantity})).sort((a,b)=>b.Quantity-a.Quantity).slice(0,20);
  return {title:"Product Master",kpis:[{key:"Products",label:"Matching Products",format:"number",value:Number(rows[0]?.TotalProducts||0)}],charts:[{type:"bar",title:"Products by Brand (displayed rows)",data:chartRows}],rows,note:"Product master reports use the live BarcodeView. Transaction-only branch, account and store filters do not redefine product master records."};
}

async function getLiveTables(pool){
  const result=await pool.request().query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE IN ('BASE TABLE','VIEW')");
  return new Set((result.recordset||[]).map(x=>String(x.TABLE_NAME).toLowerCase()));
}

async function listReports(tenantId){
  const pool=await getPoolForTenant(tenantId); const live=await getLiveTables(pool);
  return reportCatalog.map(report=>{
    const missing=report.requiredTables.filter(table=>!live.has(table.toLowerCase()));
    const supported=adaptiveEngine(report).engine!=="unavailable";
    return {...report,available:supported&&!missing.length,unavailableReason:!supported||missing.length?`Required live source is not available${missing.length?`: ${missing.join(", ")}`:""}.`:null};
  });
}

async function listFilterOptions({tenantId,user,kind,query="",branches=[]}){
  const pool=await getPoolForTenant(tenantId); const request=pool.request(); request.timeout=aiConfig.sqlTimeoutMs;
  request.input("companyCode",sql.VarChar(20),String(user.companyCode||""));
  request.input("query",sql.NVarChar(120),`%${String(query||"").trim().slice(0,100)}%`);
  if(kind==="branches"){
    const result=await request.query("SELECT TOP 200 BranchCode code,BranchName label FROM BranchFile WHERE CompanyCode=@companyCode AND Type='D' AND BranchName LIKE @query ORDER BY BranchName");
    return result.recordset||[];
  }
  if(kind==="stores"){
    const clauses=[];addListFilter(request,clauses,"sr.Branch","filterBranch",normalizeList(branches));
    const extra=clauses.length?`AND ${clauses.join(" AND ")}`:"";
    const result=await request.query(`SELECT TOP 300 sr.Code code,sr.Name label,sr.Branch branchCode,bf.BranchName branchName FROM StockRoom sr INNER JOIN BranchFile bf ON bf.BranchCode=sr.Branch WHERE bf.CompanyCode=@companyCode AND sr.Type='D' AND sr.Name LIKE @query ${extra} ORDER BY bf.BranchName,sr.Name`);
    return result.recordset||[];
  }
  if(kind==="accounts"){
    const result=await request.query("SELECT TOP 100 ActCod code,AcName label FROM AccountList WHERE ISNULL(DetActType,'')<>'Control' AND (ActCod LIKE @query OR AcName LIKE @query) ORDER BY AcName");
    return result.recordset||[];
  }
  if(kind==="products"){
    const result=await request.query("SELECT TOP 100 BarCode code,COALESCE(NULLIF(DesignDesc,''),BarCode) label,BrandName,CatagoryName FROM BarcodeView WHERE BarCode LIKE @query OR DesignNo LIKE @query OR DesignDesc LIKE @query ORDER BY DesignDesc,BarCode");
    return result.recordset||[];
  }
  const merchandiseOptions={
    brand:["Brand","BrandName"],category:["Catagory","CatagoryName"],season:["Season","SeasonName"],
    style:["Style","StyleName"],color:["Color","ColorName"],size:["Size","SizeName"],
    design:["DesignNo","DesignDesc"],barcode:["BarCode","DesignDesc"],fabric:["Fabric","FabricName"],
    department:["Department","DepartmentName"],gender:["Gender","GenderName"],cobrand:["CoBrand","CoBrandName"],
    supplier:["CoBrandClass","CoBrandClassName"],subcategory:["SubCatagory","SubCatagoryName"],
    substyle:["SubStyle","SubStyleName"],styleclass:["StyleClass","StyleClassName"],
    styleclass1:["SubStyle1Class","SubStyle1ClassName"],styleclass2:["SubStyle2Class","SubStyle2ClassName"],
    subdepartment:["SubDepartment","SubDepartmentName"],fabricclass:["FabricClass","FabricClassName"],
    colorclass:["ColorClass","ColorClassName"],
  };
  if(merchandiseOptions[kind]){
    const [codeColumn,labelColumn]=merchandiseOptions[kind];
    const result=await request.query(`SELECT TOP 300 ${codeColumn} code,COALESCE(NULLIF(${labelColumn},''),${codeColumn}) label
      FROM BarcodeView WHERE ISNULL(${codeColumn},'')<>'' AND (${codeColumn} LIKE @query OR ${labelColumn} LIKE @query)
      GROUP BY ${codeColumn},${labelColumn} ORDER BY label`);
    return result.recordset||[];
  }
  throw Object.assign(new Error("Unknown filter kind"),{status:400});
}

function adaptiveEngine(report){
  const name=report.name.toLowerCase();
  if(report.family==="target") return {engine:"unavailable"};
  if(report.family==="tax") return {engine:"fbr"};
  if(report.family==="transfer") return {engine:"transfer"};
  if(report.family==="purchase-return"||name.includes("purchase return")) return {engine:"purchase-return"};
  if(report.family==="purchase") return {engine:report.dimension&&report.dimension!=="salesman"?"purchase-dimension":"purchase-summary",dimension:report.dimension};
  if(report.family==="inventory") {
    if(name.includes("stock take")) return {engine:"stock-take"};
    if(name.includes("adjustment")) return {engine:"adjustment"};
    return {engine:"stock",dimension:report.dimension};
  }
  if(report.family==="pricing"&&name.includes("policy")) return {engine:"discount"};
  if(report.family==="product"&&/(master|price list|hierarchy|design wise barcode)/.test(name)) return {engine:"product-master"};
  if(report.family==="management"&&report.dimension&&dimensionMap[report.dimension]) return {engine:"sales-dimension",dimension:report.dimension};
  if(report.family==="management") return {engine:"executive"};
  if(name.includes("cash")||name.includes("card")||name.includes("credit")||name.includes("payment")) return {engine:"payment"};
  if(report.family==="sales"||report.family==="product"||report.family==="pricing") return {engine:report.dimension?"sales-dimension":"sales-summary",dimension:dimensionMap[report.dimension]?report.dimension:null};
  return {engine:"executive"};
}

async function executeAdaptiveEngine(adaptive,pool,user,filters){
  if(adaptive.engine==="sales-summary") return runSalesSummary(pool,user,filters);
  if(adaptive.engine==="sales-dimension") return runSalesDimension(pool,user,filters,adaptive.dimension);
  if(adaptive.engine==="purchase-summary") return runPurchase(pool,user,filters);
  if(adaptive.engine==="purchase-dimension") return runPurchase(pool,user,filters,{dimension:adaptive.dimension});
  if(adaptive.engine==="purchase-return") return runPurchase(pool,user,filters,{isReturn:true});
  if(adaptive.engine==="payment") return runPayment(pool,user,filters);
  if(adaptive.engine==="transfer") return runTransfer(pool,user,filters);
  if(adaptive.engine==="adjustment") return runSimpleInventory(pool,user,filters,"adjustment");
  if(adaptive.engine==="stock-take") return runSimpleInventory(pool,user,filters,"take");
  if(adaptive.engine==="stock") return runStock(pool,user,filters,adaptive.dimension);
  if(adaptive.engine==="discount") return runDiscount(pool,user,filters);
  if(adaptive.engine==="fbr") return runFbr(pool,user,filters);
  if(adaptive.engine==="product-master") return runProductMaster(pool,user,filters);
  if(adaptive.engine==="executive"){
    const [sales,purchase,transfers]=await Promise.all([runSalesSummary(pool,user,filters),runPurchase(pool,user,filters),runTransfer(pool,user,filters)]);
    return {title:"Executive Business Dashboard",kpis:[...sales.kpis.slice(0,4),...purchase.kpis.slice(0,2),...transfers.kpis.slice(0,1)],charts:[...sales.charts,...purchase.charts,...transfers.charts],rows:sales.rows};
  }
  throw new Error("Report engine is not implemented");
}

function previousPeriod(filters){
  const start=new Date(`${filters.fromDate}T00:00:00Z`);const end=new Date(`${filters.toDate}T00:00:00Z`);const days=Math.max(1,Math.round((end-start)/86400000)+1);
  const previousEnd=new Date(start);previousEnd.setUTCDate(previousEnd.getUTCDate()-1);const previousStart=new Date(previousEnd);previousStart.setUTCDate(previousStart.getUTCDate()-days+1);
  return {...filters,fromDate:previousStart.toISOString().slice(0,10),toDate:previousEnd.toISOString().slice(0,10)};
}

function addPredictiveBaseline(output,previousPeriods,filters,report){
  const primary=output.kpis.find(kpi=>kpi.format==="currency")||output.kpis[0];if(!primary)return output;
  const previousValues=previousPeriods.map(previous=>{const prior=previous.kpis.find(kpi=>kpi.key===primary.key)||previous.kpis.find(kpi=>kpi.format===primary.format)||previous.kpis[0];return Number(prior?.value||0);});
  const currentValue=Number(primary.value||0);const previousValue=previousValues[0]||0;const selectedDays=Math.max(1,Math.round((new Date(`${filters.toDate}T00:00:00Z`)-new Date(`${filters.fromDate}T00:00:00Z`))/86400000)+1);
  const horizon=Number(report.name.match(/Next (7|15|30|90) Days/i)?.[1]||selectedDays);const historicalAverage=previousValues.reduce((sum,value)=>sum+value,0)/Math.max(1,previousValues.length);const baseline=historicalAverage/selectedDays*horizon;const change=previousValue===0?0:(currentValue-previousValue)*100/Math.abs(previousValue);
  return {...output,kpis:[...output.kpis,{key:"PreviousPeriod",label:"Previous Comparable Period",format:primary.format,value:previousValue},{key:"BaselineProjection",label:`3-Period ${horizon}-Day Forecast`,format:primary.format,value:baseline},{key:"PeriodChange",label:"Period Change %",format:"percent",value:change}],note:`Forecast uses the moving-average daily pace from 3 previous equal-length live periods, scaled to ${horizon} days. Cherry AI explains this deterministic planning signal; it does not invent figures.`};
}

async function runReport({tenantId,user,code,filters:input}){
  const pool=await getPoolForTenant(tenantId); const filters=normalizeFilters(input); const report=reportCatalog.find(x=>x.code===code);
  if(!report){const error=new Error("Unknown report code");error.status=404;throw error;}
  const live=await getLiveTables(pool); const missing=report.requiredTables.filter(t=>!live.has(t.toLowerCase()));
  const adaptive=adaptiveEngine(report);
  if(adaptive.engine==="unavailable"||missing.length){const error=new Error(`Report source unavailable${missing.length?`: ${missing.join(", ")}`:""}`);error.status=422;throw error;}
  let output=await executeAdaptiveEngine(adaptive,pool,user,filters);
  if(report.mode==="predictive"){
    const periods=[];let cursor=filters;for(let index=0;index<3;index++){cursor=previousPeriod(cursor);periods.push(cursor);}
    const previous=await Promise.all(periods.map(period=>executeAdaptiveEngine(adaptive,pool,user,period)));
    output=addPredictiveBaseline(output,previous,filters,report);
  }
  return {...output,title:report.name,code:report.code,category:report.category,uiVariant:report.uiVariant,family:report.family,mode:report.mode,descriptionLines:report.descriptionLines,filters,source:"live-database",generatedAt:new Date().toISOString(),note:output.note||(report.mode==="predictive"?"Predictive insight is based only on the selected live historical scope; unavailable facts are never fabricated.":undefined)};
}

module.exports={listReports,listFilterOptions,runReport,normalizeFilters,runSalesSummary,runSalesDimension,runPurchase,runPayment,runTransfer,runStock};
