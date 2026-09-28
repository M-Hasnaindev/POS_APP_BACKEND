const {compileSalesReport}=require('./salesSemanticCompiler');
const {compileForecastReport,supported:forecastSupported}=require('./forecastSemanticCompiler');
const {compilePurchaseReport,supported:purchaseSupported}=require('./purchaseSemanticCompiler');
const supportsLive=code=>/^RPT_02_(00[1-9]|01[0-9]|02[0-2])_/.test(code)||forecastSupported(code)||purchaseSupported(code);
function compileReport(report,schema,filters,permissions,options){
  return compileSalesReport(report,schema,filters,permissions,options)||compileForecastReport(report,schema,filters,permissions,options)||compilePurchaseReport(report,schema,filters,permissions,options);
}
module.exports={compileReport,supportsLive};
