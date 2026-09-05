# Cherry POS - Starter/Fast Reasoning Ollama Profile

Recommended cloud profile for the AI Assistant when DeepSeek V4 Pro is not available on the current Ollama plan.

Primary model: `gpt-oss:20b-cloud`

Why it is used:
- low-usage cloud tag in Ollama's model library
- tool calling support
- configurable low / medium / high reasoning effort
- 128K context window
- designed for lower-latency/specialized workloads

Runtime routing:
- verified sales/stock/purchase/payment questions: deterministic live SQL first
- ordinary AI wording/formatting: low reasoning
- schema/SQL planning: no/medium reasoning depending on path
- why/analyze/strategy/prediction explanation: high reasoning
- numerical sales/demand/stock forecasts remain deterministic from live historical POS data; the LLM only explains the verified forecast

Run once after updating the backend:

    npm run use:ollama-starter
    npm run detect:ollama-model
    npm run test:ollama-cloud

The first command preserves the existing `OLLAMA_API_KEY` and only updates model/routing settings.

Important: Ollama Cloud Free is not unlimited. It includes starter usage for starter models. If the monthly starter usage is exhausted, cloud model calls can still be rejected until usage resets or credits are added. Deterministic verified SQL routes continue to work without an LLM.
