# CherryTech POS AI Assistant — 10,000 Question Safe-Intent Training Layer

This backend contains the production runtime training/intent-guard layer built from the two POS structure workbooks and the 10,000-question training bank.

## Goal

The question bank is not a source of live figures. Its purpose is to understand how users may phrase the same business question in English, Roman English, Urdu, synonyms and common typos, then map that wording to the correct POS intent.

Examples:

- branch / shop / dukaan / outlet -> branch
- stockroom / warehouse / godown -> stock room
- product / item / article / barcode / design -> merchandise/product intent
- supplier / vendor -> supplier
- salesman / salesperson / sales staff -> salesman
- sale / sales / bikri / farokht -> sales
- purchase / khareed / kharid -> purchase

## Anti-wrong-answer flow

Every Assistant turn follows this safety pipeline:

1. Normalize English/Roman-English/Urdu wording, synonyms and common typos.
2. Parse explicit business signals from the CURRENT user question.
3. Retrieve the closest examples from exactly 10,000 training questions.
4. Vote on canonical domain/dimension/operation and cross-check the vote against the user's explicit wording.
5. Select a pre-annotated safe route: verified report, verified direct SQL engine, deterministic forecast, documented schema answer, or guarded planner.
6. If the wording is ambiguous or the training vote conflicts with explicit intent, ask a cross-question instead of guessing.
7. All real transaction figures come only from the authenticated tenant/company live MSSQL database.
8. Master-data joins in core reports are de-duplicated so duplicate master rows do not multiply totals.

## 10,000-question semantic index

- `ai/questionBank.generated.json` — exactly 10,000 compiled questions.
- `ai/questionIntentIndex.generated.json` — exactly 10,000 pre-classified safe intent/route annotations.
- `ai/questionBankTraining.js` — fast exact/nearest-example retrieval.
- `ai/trainingSemanticRouter.js` — weighted intent vote + explicit-intent cross-check + ambiguity guard.
- `ai/intentParser.js` — canonical POS domain/dimension/metric/operation parser.
- `ai/posLanguage.js` — synonym, Roman-English, Urdu and common typo normalization.
- `ai/trainingKnowledge.generated.json` — documented table/field/business knowledge.

Current route-policy coverage of the 10,000 questions is intentionally mixed. Questions with an exact deterministic implementation use verified reports/direct engines. Questions whose business logic cannot safely be assumed use the guarded planner or clarification path rather than being forced into an unrelated generic report.

## Verification

Run:

```bash
npm run test:assistant-training
```

The test suite verifies:

- exactly 10,000 questions exist;
- exactly 10,000 safe intent annotations exist;
- no training question is left without a safe execution policy;
- branch/shop/dukaan/outlet and other synonym variants keep the same intent;
- common typos are normalized;
- ambiguous metric-only questions trigger clarification;
- unsupported advanced intents are not silently mapped to a generic report;
- cash/card/credit sales route to tender/payment results instead of total sales;
- stock valuation wording remains stock intent even if it contains purchase-price wording;
- multi-turn conversation and Ollama thinking adapters still pass.

The authenticated `/api/ai/health` endpoint exposes the 10,000-question corpus count, semantic-index count, route-policy counts and ambiguity-guard status.

## Important rule

No finite question bank or LLM can mathematically guarantee the correct interpretation of every possible human sentence. The production safety rule is therefore: **when the system cannot establish one verified interpretation with enough confidence, it asks a cross-question instead of returning a confident potentially-wrong answer.**

## Centralized Multi-Tenant Training (2026-09-05)

The 10,000-question bank is now tenant-independent. Literal example branch/store/employee/product/barcode/account values from the source workbook are masked in `ai/questionBank.generated.json`. The bank teaches wording, synonyms, intent and business routing only.

Authoritative runtime order:
1. authenticated `tenantId` selects the current MSSQL database;
2. authenticated `companyCode` scopes company-bearing transaction data;
3. user wording is interpreted through centralized synonyms + the 10k intent bank;
4. deterministic verified engines are preferred;
5. guarded planner reads the CURRENT tenant live database catalog for additional same-schema tables;
6. names/codes/amounts are returned only from live tenant rows, never from training examples.

### Supplier payment rule
`supplier/vendor + payment/paid/paise diye` is an accounting-ledger intent, not the POS cash/card/credit tender report. The verified engine reads CBook + BBook `/P/` payment vouchers, `BookAccount='N'`, excludes cancelled vouchers, filters the authenticated CompanyCode/date/branch scope, identifies suppliers through `Chart.PartyType='S'`, and returns `Chart.AcName` with the exact aggregated payment amount.
