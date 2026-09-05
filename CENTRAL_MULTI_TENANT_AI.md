# Central Multi-Tenant AI Assistant

This build intentionally separates **training semantics** from **tenant data**.

- 10,000 templates: language, synonyms and canonical intent only.
- Tenant DB: selected at runtime from authenticated `tenantId`.
- Company: scoped from authenticated `companyCode`.
- Live names/amounts: never taken from the question bank.
- Full-schema fallback: planner can inspect the current tenant's live user-table/view catalog rather than being limited to the original 32 training tables.
- Anti-wrong-answer rule: deterministic engine first; otherwise live-schema grounded planner; clarify if confidence is insufficient.

## Verified accounting intent
Supplier payment questions use accounting ledgers (`CBook`, `BBook`, `Chart`) rather than POS tender mix (`PosPayment`, `UnPosPayment`).
