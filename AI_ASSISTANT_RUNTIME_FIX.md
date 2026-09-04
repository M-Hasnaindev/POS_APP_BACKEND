# AI Assistant Forecast / Analysis Runtime Fix

This build fixes three production failures:

1. Forecast paths call verified report engines directly. Missing empty filter arrays no longer throw before SQL runs, and forecast history is normalized before execution.
2. DeepSeek analysis no longer receives GPT-OSS-style `think: high/medium` strings. DeepSeek and other non-GPT-OSS models receive boolean `think: true/false`.
3. Common sales/purchase/stock/payment/transfer analysis is routed through verified live SQL first and then only one bounded Cloud reasoning call. If Cloud reasoning times out or is temporarily unavailable, the Assistant returns a verified deterministic analysis instead of failing the request.

`OLLAMA_ANALYSIS_TIMEOUT_MS=48000` keeps the optional reasoning call below common gateway limits.
