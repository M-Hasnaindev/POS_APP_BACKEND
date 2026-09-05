# Cherry POS - Ollama Cloud Upgrade

This backend is configured for direct Ollama Cloud access. Local `ollama serve`, `ollama pull`, and `ollama run` are not required in cloud mode.

## 1) Security first

If an API key was pasted into chat, email, screenshot, ticket, or source code, revoke that key in Ollama and create a new one. Do not reuse the exposed key.

Never put `OLLAMA_API_KEY` in the React Native frontend. Keep it only in the backend `.env` and in your hosting provider's secret environment variables.

## 2) One-command Windows setup

From the backend folder run:

```powershell
npm run configure:ollama-cloud
```

The script:
- asks for the NEW API key without printing it,
- updates `.env`,
- switches the backend to `https://ollama.com`,
- configures DeepSeek V4 Pro,
- tests known model aliases,
- saves the working alias in `OLLAMA_MODEL`.

Then run:

```powershell
npm run test:ollama-cloud
```

Expected result:

```text
Ollama Cloud: OK
Model response: CLOUD_OK
```

## 3) Start/restart backend

```powershell
npm install
npm start
```

If the backend was already running, stop it and restart it after changing `.env`.

## 4) Production/Vercel environment

Set these backend-only environment variables in the deployment platform:

```text
OLLAMA_BASE_URL=https://ollama.com
OLLAMA_API_KEY=<NEW_SECRET_KEY>
OLLAMA_MODEL=gpt-oss:20b-cloud
OLLAMA_MODEL_CANDIDATES=deepseek-v4-pro,deepseek-v4-pro:0813,deepseek-v4-pro:cloud,deepseek-v4-pro:0813-cloud
OLLAMA_TIMEOUT_MS=120000
OLLAMA_ANALYSIS_TIMEOUT_MS=48000
OLLAMA_NUM_CTX=16384
OLLAMA_NUM_PREDICT=4096
OLLAMA_THINKING=false
OLLAMA_PLANNER_THINK_LEVEL=medium
OLLAMA_COMPLEX_THINK_LEVEL=high
OLLAMA_MAX_THINKING=false
```

Redeploy/restart the backend after saving the variables.

## 5) What changed in code

- Direct Ollama Cloud Bearer authentication is supported.
- Missing/invalid cloud keys now return a clear backend error instead of silently behaving like local Ollama.
- Known DeepSeek cloud aliases are retried only when Ollama reports a model-name/manifest error.
- Simple/verified POS questions still use deterministic SQL first for speed and exact figures.
- Complex business explanation uses DeepSeek boolean thinking. `medium/high` configuration values are automatically normalized to `think: true` for DeepSeek; string levels are preserved only for GPT-OSS-compatible models.
- SQL planning remains no-thinking/fast so a complex model does not turn normal chat into a timeout.
- AI report narrative remains bounded and falls back to verified live KPIs if the model is busy.
- The API key is never returned to the mobile app or health endpoint.

## 6) Recommended smoke test in the app

After backend restart, test:

1. `Aaj ki net sale batao`
2. `Aur kal?`
3. `Branch wise?`
4. `Top 5?`
5. `Sab se weak branch kyun weak hai?`
6. `Next 30 days ka forecast batao`
7. Switch to Urdu and ask: `آج سب سے زیادہ سیلز کس برانچ کی ہوئی؟`

The first four should stay fast because they use verified SQL paths. The deeper `kyun`/analysis question is where the cloud model can add reasoning.

## 7) Local Ollama removal

Only stop/uninstall local Ollama after `npm run test:ollama-cloud` and app testing pass. No frontend code change is required for the cloud migration.
