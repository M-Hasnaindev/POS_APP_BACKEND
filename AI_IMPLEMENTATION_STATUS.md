# AI implementation and verification status

Updated 2026-09-28. This is not a claim that all 460 reports are complete.

## Deterministic report coverage: 51 of 460

| Report codes | Count | Implemented calculation |
| --- | ---: | --- |
| RPT_02_001 through RPT_02_022 | 22 | Paid closed/unclosed sales, full document keys, signed returns, historical purchase cost, requested dimensions, reconciled totals |
| RPT_05_001 through RPT_05_009 | 9 | Purchases/returns from final detail amount, header date/supplier, cancellation rules, equal-length preceding period, weighted average rate |
| RPT_08_001 through RPT_08_020 | 20 | Three preceding equal-length periods, calendar-day average, explicit forecast horizon, disclosed historical stability score |

All 51 have a bounded, authenticated live SQL Server execution route. Client or LLM SQL is never executed by that route. Company and branch permissions come from authenticated server context. Facts are materialized in connection-local temporary tables so totals/detail/check use the same captured rows. Live reads are not guaranteed to be a point-in-time snapshot while the source POS is concurrently writing.

The remaining 409 catalog entries still use the existing AI-planned local-query route. They have generic reconciliation but are **not individually verified business calculations**. In particular, inventory aging, targets/incentives, price/discount recommendations, specialized forecasts and management composites need their own source-specific contracts and tests; do not substitute a similarly named aggregate report and count it as complete.

## Forecast baseline assumptions

- Document basis: user-provided `AI REPORTS WORK FLOW.txt`, global forecast rule.
- History: three periods immediately before the selected analysis period, each the same number of calendar days.
- Forecast: historical amount/quantity/profit divided by historical calendar-day count, multiplied by horizon.
- Daily/weekly/monthly horizons: 1/7/30 days; Next 7/15/30/90 titles override the horizon.
- Growth compares the projection with the selected-period pace scaled to the same horizon.
- `ConfidencePercent` is a disclosed baseline **stability score**, not probability or backtested accuracy: `100 * max(0, 1 - mean absolute deviation / abs(mean))` over the three period amounts.
- No historical rows: forecast/confidence unavailable, not zero. Zero comparison denominator: growth unavailable.
- Missing historical coverage cannot be inferred from no rows; users must verify coverage. No seasonality, causal growth, or price elasticity is claimed.
- Assumptions remain visible in report/assistant highlights and PDF, Excel, and text-share exports.

## Tests

- Assistant language adapter: 264 sales/purchase phrasing variants plus follow-up period/grouping, domain-switch, ambiguous `kal`, invalid-date, and unknown named-filter cases. This is deterministic intent coverage, not model fine-tuning or proof of arbitrary natural-language accuracy.

- `npm run test:ai`: deterministic numeric SQLite fixtures and live-route safety checks. No POS data is written.
- `node scripts/testLiveSalesCompiler.js --all`: SQL Server syntax and empty-period result reconciliation. This is **not** a financial reconciliation against real business totals.
- Frontend `npm run test:ai`: local/live fallback, reconciliation, 10,000-row SQLite inserts/deltas/rollback, resume/consent/authentication, native plugin generation, voice lifecycle mocks, export content escaping/assumption retention.
- Frontend TypeScript checks and lint are run separately.

## Still requires physical-device acceptance

Voice recognition accuracy, permissions on a real phone, OS background/force-stop behavior, long-download recovery under real network loss, and visual PDF/Excel layout are not proven by mocked tests. Native plugin changes require a compatible native app binary. No APK was built by these verification steps.
