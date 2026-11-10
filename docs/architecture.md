# Architecture

## Role

TAL1 is a **single tail consumer** for many producer Workers. It:

1. Normalizes tail events into Analytics Engine `invocation_slo` (error rates / wall time by script, outcome, coarse route — **no stack in AE**)
2. Forwards remapped uncaught exceptions to **tal1 Workers Logs** and sch1 Intake (`ops.error` / `uncaught_exception`)

## Data flow

1. Producer runs (fetch, cron, queue, …). With `upload_source_maps = true`, CF remaps uncaught stacks after the invocation.
2. Cloudflare invokes TAL1 `tail(events)` with trace metadata (including `exceptions[]` / optional `logs[].errorInfo`).
3. `traceToPoint()` → `recordInvocationSamples()` writes AE (skips empty `scriptName` and self `tal1`).
4. `analyzeExceptionEvent()` / `recordExceptionHub()` → `console.error` JSON; uncaught only → `buildOpsErrorIntake` + `submitIntakeEventAsync` (`waitUntil`).

## Design choices

| Choice | Rationale |
|--------|-----------|
| Separate dataset from app SLO | Avoid mixing invocation metrics with `kind` / `because` business samples |
| Path = first two segments | Enough for `/v1/chat`-style grouping; limits cardinality vs full URL |
| Stack not in AE | blob 256-char limit; high-cardinality text breaks SLO GROUP BY |
| Stack in Logs + Intake | System runtime signal for crash localization; Intake daily-deduped, no email flood |
| Platform transients → warn, no Intake | CF container/DO capacity errors are retryable; `console.error` of `tal1_exception` trips `telemetry_error_burst` |
| `errorInfo` not Intake | Caught logs already may go via business `reportOpsError` |
| No app log parsing for SLO | Fragile; business SLO belongs in app code or structured metrics |
| No `await` on `writeDataPoint` | Matches CF guidance; intake uses `waitUntil` |
| `SVC_SCH1` allowed; no D1/KV/外网 | Intake via Service Binding stays cheap |
| `fetch` health only | No Bearer API; not an MCP/agent surface |

## Cost and volume

- Every producer invocation triggers **one** tail invocation on TAL1.
- A request through edge gateway + origin Worker produces **two** AE points (expected).
- Keep tail handler minimal: no `fetch` to external endpoints, no KV/D1.

## When not to use this

- You only need Cloudflare Dashboard / Workers Logs on the producer → enable `upload_source_maps` + built-in observability.
- You need batch export to SaaS → consider [OTEL destinations](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/).
- You need `because` / validation failure reasons → instrument in application code, not tail logs.

## Customization

- **Script name:** change `name` in `wrangler.toml` and `service` in producer `tail_consumers`.
- **Dataset name:** change `dataset` under `[[analytics_engine_datasets]]` and SQL queries.
- **Columns:** edit `src/trace-to-point.ts`; keep tests in sync.
- **Exception hub:** edit `src/exception-hub.ts`.
