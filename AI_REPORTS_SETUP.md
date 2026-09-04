# Cherry AI Reports - Live MSSQL via Ollama

## Runtime flow

AI Reports now use the authenticated tenant database directly through the Node backend:

1. Mobile sends report code + selected filters with the user's JWT.
2. Backend resolves `tenantId` from the verified JWT and opens that tenant's existing MSSQL pool.
3. Backend reads the relevant live schema from `INFORMATION_SCHEMA.COLUMNS`.
4. Ollama receives the report contract, business rules, selected parameter names and ONLY the live schema for relevant allowed tables.
5. Ollama returns two read-only SQL Server 2014 queries: one KPI summary query and one detail/chart query.
6. Backend validates the generated SQL (SELECT/CTE only, allowed live tables only, no comments/batches/destructive statements, only bound parameters, CompanyCode isolation when applicable).
7. Backend executes both queries on the SAME authenticated tenant MSSQL pool.
8. If the first plan fails SQL validation/execution, Cherry AI gets the SQL error + authoritative schema and performs one controlled repair attempt.
9. Numeric MSSQL results are returned to the report UI, then Ollama explains only those returned figures for management insight.

Ollama never receives MSSQL credentials and never opens a DB connection itself. Node is the safe execution bridge.

## Required environment variables

```env
OLLAMA_BASE_URL=https://ollama.com
OLLAMA_API_KEY=YOUR_BACKEND_ONLY_KEY
OLLAMA_MODEL=deepseek-v4-pro
OLLAMA_TIMEOUT_MS=120000
AI_SQL_TIMEOUT_MS=60000
AI_MAX_ROWS=200
AI_INCLUDE_SQL_DEBUG=false
```

Production now uses Ollama Cloud directly. Keep `OLLAMA_API_KEY` only in the backend/Vercel environment; never put it in the React Native app. No local Ollama process or model pull is required for cloud mode.

## Development SQL verification

Set:

```env
AI_INCLUDE_SQL_DEBUG=true
```

to include the validated generated `summarySql`, `detailSql`, live table list and repair flag in the API response. Keep it `false` in normal production use.

## Safety guarantees

- JWT chooses the tenant; the client cannot send a raw DB connection string.
- Only known POS/ERP tables from `ai/knowledge.js` are eligible.
- Generated SQL must be read-only SELECT/CTE.
- SQL comments, semicolon batches, DDL/DML, EXEC, OPENROWSET and system DB access are blocked.
- Unknown SQL parameters are blocked; selected filter values are bound by Node rather than pasted into SQL.
- If a used live table exposes `CompanyCode`, generated SQL must use the authenticated `@companyCode` parameter.
- AI cannot fabricate numeric report values: report figures come from MSSQL result sets.
