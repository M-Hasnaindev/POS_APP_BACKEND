const { fail } = require("./adminStore");
function dotenvValue(value) {
  const text = String(value ?? "");
  // dotenv strips outer delimiters but does not JSON-unescape quotes/backslashes.
  // Single quotes/backticks preserve literal newlines and backslashes exactly.
  for (const quote of ["'", "`"])
    if (!text.includes(quote)) return quote + text + quote;
  if (!text.includes('"') && !/\\[nr]/.test(text)) return '"' + text + '"';
  if (!/[\r\n#]/.test(text) && text.trim() === text && !/^["'`]/.test(text))
    return text;
  throw fail(
    "An application variable cannot be represented losslessly as dotenv. Use individual reveal instead.",
    422,
    "ADMIN_ENV_EXPORT_UNSUPPORTED",
  );
}
module.exports = { dotenvValue };
