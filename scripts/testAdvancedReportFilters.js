require("dotenv").config({ quiet: true });
const assert = require("assert");
const reportService = require("../services/reportService");
const { getPoolForTenant, closeAllPools } = require("../config/db");

const filterMap = {
  brand:"brands",category:"categories",season:"seasons",style:"styles",color:"colors",size:"sizes",
  design:"designs",barcode:"barcodes",fabric:"fabrics",department:"departments",gender:"genders",
  cobrand:"cobrands",supplier:"suppliers",subcategory:"subcategories",substyle:"substyles",
  styleclass:"styleclasses",styleclass1:"styleclass1",styleclass2:"styleclass2",
  subdepartment:"subdepartments",fabricclass:"fabricclasses",colorclass:"colorclasses",
};

async function main(){
  const tenantId="tenant_1";const pool=await getPoolForTenant(tenantId);
  const identity=(await pool.request().query("SELECT TOP 1 UserID,CompanyCode FROM Security WHERE UserID IS NOT NULL")).recordset[0];
  const user={companyCode:identity.CompanyCode};const filters={fromDate:"2026-08-31",toDate:"2026-08-31"};
  for(const [kind,key] of Object.entries(filterMap)){
    const options=await reportService.listFilterOptions({tenantId,user,kind});
    assert(Array.isArray(options),`${kind} options must be an array`);
    if(options[0])filters[key]=[options[0].code];
  }
  for(const code of ["RPT_02_001_SALES_SUMMARY","RPT_05_001_PURCHASE_REGISTER","RPT_05_004_BARCODE_WISE_PURCHASE","RPT_06_013_SENT_VS_RECEIVED_QUANTITY","RPT_03_001_CURRENT_STOCK","RPT_03_006_BRAND_WISE_STOCK","RPT_02_032_CASH_CARD_CREDIT_SALES","RPT_16_016_DISCOUNT_POLICY_COMPLIANCE","RPT_07_001_BARCODE_MASTER","RPT_26_001_FBR_SALES_SUMMARY"]){
    const report=await reportService.runReport({tenantId,user,code,filters});
    assert.equal(report.source,"live-database");
  }
  const predictive=await reportService.runReport({tenantId,user,code:"RPT_08_017_NEXT_7_DAYS_SALES_FORECAST",filters});
  assert(predictive.kpis.some(kpi=>kpi.key==="BaselineProjection"));
  console.log("Advanced filters passed across sales, purchase, transfer, stock, payment, and discount engines");
}

main().catch(error=>{console.error(error);process.exitCode=1;}).finally(closeAllPools);
