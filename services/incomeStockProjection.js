const crypto=require('node:crypto');
// Reviewed POSStockMovement source from UROOJ. Unknown ERP versions keep the
// original stored-procedure capture path; never rewrite unrecognized SQL.
const VERIFIED_DEFINITION_SHA256='2dd54ddfd4aa92b16ce1e610727834d92417835461673a1ebc0677092ef4db4d';
const projection=`
 SELECT Branch,SUM(OpAmt) AS OpAmt,SUM(BalAmt) AS BalAmt,COUNT_BIG(*) AS SourceRows,
 SUM(CASE WHEN OpAmt IS NULL OR BalAmt IS NULL THEN 1 ELSE 0 END) AS InvalidAmounts
 FROM (
  SELECT Branch,StoreCode,Style,Brand,Catagory,Season,Barcode,
   SUM(OpAmt) AS OpAmt,SUM(BalAmt) AS BalAmt
  FROM Report7Rows WHERE Barcode IS NOT NULL
  GROUP BY Branch,StoreCode,Style,Brand,Catagory,Season,Barcode
 ) AS IncomeValuationGroups GROUP BY Branch `;
function projectionForDefinition(definition){
 if(typeof definition!=='string'||crypto.createHash('sha256').update(definition).digest('hex')!==VERIFIED_DEFINITION_SHA256)return null;
 const header=definition.indexOf('\nAS\r\n');if(header<0)return null;
 const body=definition.slice(header+4),cte=body.indexOf('Report7Rows AS');
 const from=body.indexOf('\nSelect\r\n',cte),to=body.indexOf('OPTION (MAXDOP 4, RECOMPILE);',from);
 if(cte<0||from<0||to<0)return null;
 // Inputs force report 7, IncludeZeroBal Y. Its HAVING predicate is always true.
 // Preserve its numeric group boundaries and null rules, while omitting all
 // descriptive fields, images and final per-product ORDER BY. No DDL persists.
 return body.slice(0,from)+projection+body.slice(to);
}
function projectionForMetadata(metadata){
 if(metadata?.callerSchema!=='dbo'||metadata.uses_ansi_nulls!==true||metadata.uses_quoted_identifier!==true||metadata.sessionAnsiNulls!==1||metadata.sessionQuotedIdentifier!==1)return null;
 return projectionForDefinition(metadata.definition);
}
module.exports={projectionForDefinition,projectionForMetadata,VERIFIED_DEFINITION_SHA256};
