# IntentProof

AI agents can move money. IntentProof enforces that they move it only as the merchant approved.

IntentProof is a merchant-controlled policy gateway for AI payment agents. It combines deterministic
policy checks, transactional budget reservations, a narrow Razorpay MCP boundary, raw-byte webhook
verification, and a tamper-evident audit export.

The project uses Razorpay Test Mode only. Never use live credentials or real customer data.

## Current Status

- [x] Frozen Open Track specification.
- [x] Strict TypeScript repository.
- [x] Transactional audit records in SQLite.
- [x] Atomic JSONL export and ledger verification.
- [x] Raw-body webhook HMAC verification.
- [x] Correct byte-semantics tests for original, tampered, re-signed, and pretty-printed payloads.
- [x] Official Razorpay MCP Docker stdio client with Test Mode-only credential guard.
- [x] Docker transport probe listing 41 tools from the installed official image.
- [x] Narrow MCP gateway exposing only `create_order`, `create_payment_link`, and `capture_payment`.
- [x] Fake-upstream integration coverage proving non-`ALLOW` verdicts do not dispatch.
- [x] Deterministic policy engine with all four verdicts.
- [ ] Real Razorpay Test Mode webhook replay (requested externally; evidence remains visibly pending).
- [x] Successful credentialed `fetch_all_payments` read evidence with response data omitted.
- [x] One INR 1 Test Mode order passed through the gateway; each non-`ALLOW` verdict made zero upstream calls.
- [x] Transactional `RESERVED`, `COMMITTED`, `RELEASED`, and `IN_DOUBT` executor lifecycle.
- [x] SQLite-backed idempotency and dispatch-time kill-switch/version checks.
- [x] Crash recovery and bounded read-only reconciliation for `IN_DOUBT` reservations.
- [x] Counterfactual Lab replay foundation with bounded schedule exploration and trace minimization.
- [x] Offline mandate compiler with strict review, explicit approval, immutable versions, and a safe demo agent.
- [x] Constrained model-backed planner with strict proposals and gateway-only execution.
- [x] Canonical versioned evidence bundle with provenance, hashes, verification, and scoreboard.
- [x] Local Control Room with mandate approval, constrained agent runs, audit, Lab replay, and proof views.

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm test
npm run build
```

Fill `.env` locally. Never commit it.

## Control Room

The Control Room is a React and TypeScript interface over narrowly scoped Express endpoints. The
browser never receives credentials, raw webhook bodies, database rows, or policy authority. Drafts
use the deterministic fake compiler, agent proposals use the constrained fake planner, all verdicts
come from the existing gateway and policy engine, and upstream execution is fake-only.

Keep the webhook listener on its existing port. Run a second local backend instance on a separate
port, then start Vite on port 4173:

```powershell
$env:PORT = "8787"
$env:DB_PATH = ".control-room.db"
npm start
```

In another terminal:

```powershell
npm run dev:frontend
```

Open `http://127.0.0.1:4173`. The Vite server proxies only `/api` requests to the local Control Room
backend. The Evidence screen deliberately preserves the genuine webhook as
`PENDING_EXTERNAL_REPLAY` until real signed evidence exists.

## Mandate Compiler and Approval

Create a draft with the deterministic fake compiler:

```powershell
npm run mandate -- draft --input examples/mandates/shop-owner.txt --provider fake --output mandate-draft.json
npm run mandate -- review mandate-draft.json
npm run mandate -- approve mandate-draft.json --approved-by demo-merchant --output mandate-approved.json
npm run mandate -- diff mandates/default.yaml mandate-approved.json
```

Use `--provider gemini` to call Gemini with `LLM_API_KEY` from the process environment. The compiler
sends only the redacted merchant instruction. It never receives gateway events, audit rows, payment
arguments, or Razorpay credentials. Malformed output, timeout, unknown fields, missing source
coverage, unsupported instructions, ambiguity, and quotes that are not exact source substrings all
fail closed.

A draft is a separate schema and cannot be loaded by the gateway. `approve` requires a named human
approver, prints the rule diff first, assigns the proposed version, and creates an approved artifact
with a deterministic content hash and draft provenance. Approved files use create-once writes, so an
existing version is never overwritten.

Run the deterministic agent demonstration against the fake upstream:

```powershell
npm run agent
```

The transcript shows the agent request, matching mandate quote, deterministic verdict, upstream-call
count, and audit evidence for allowed, blocked, held, abstained, kill-switch, and stale-version
cases. The demo agent receives only the IntentProof gateway interface and has no upstream client or
credentials.

Run the separate model-planner demonstration:

```powershell
npm run planner:demo
```

The planner may propose only `create_order`, `create_payment_link`, `capture_payment`, or
`no_action`. Strict validation rejects malformed JSON, unknown tools or fields, incomplete
arguments, non-INR currency, invalid paise values, oversized output, sensitive input, and provider
timeouts before the gateway is called. Valid mutation proposals are validated again against the
gateway schema. Their intent ID becomes a stable idempotency key, and the existing deterministic
policy engine remains the only component that can return `ALLOW`, `BLOCK`, `HOLD_FOR_APPROVAL`, or
`ABSTAIN`.

An optional live Gemini smoke test performs planning only:

```powershell
npm run planner:smoke -- --objective "Place an order for 19900 paise."
```

It needs `LLM_API_KEY` in the process environment. The smoke command imports no gateway, MCP,
dispatcher, or upstream client and therefore cannot reach Razorpay. It prints only the validated
tool, intent ID, explanation, and validation metadata; mutation arguments are not logged.

Probe the official local Razorpay MCP server and retain only sanitized evidence:

```powershell
npm run probe:upstream
```

The probe lists upstream tool names and calls `fetch_all_payments` with `count: 1`. It never
stores credentials or the read response body. IntentProof rejects any key ID that does not start
with `rzp_test_`.

Start the narrow MCP gateway over stdio:

```powershell
npm run gateway
```

The gateway registers exactly the three MVP mutation tools. Calls that return `BLOCK`,
`HOLD_FOR_APPROVAL`, or `ABSTAIN` are recorded and returned without invoking Razorpay.

The mutating integration probe is intentionally one-shot:

```powershell
npm run probe:gateway
```

It creates one INR 1 Test Mode order, then checks the three non-`ALLOW` paths with an upstream-boundary
counter. It refuses to run again once `evidence/gateway-pass-through.json` exists.

Callers may provide `idempotency_key`. If they do not, IntentProof hashes the mandate, agent, tool,
canonical arguments, and a five-minute logical window. Reusing a key returns the stored lifecycle
state and never dispatches again. Each reservation also stores a request fingerprint and a durable
correlation value: an order receipt, a payment-link reference ID, or the existing payment ID. A key
cannot be reused with different mutation arguments, and correlation values are locally unique.

If a process stops before a reservation is claimed for dispatch, recovery releases the stale row as
`never_sent_recovery`. A claimed stale reservation is treated as `IN_DOUBT`, because the call may
have reached Razorpay. Startup performs recovery, and the maintenance loop repeats it after a short
staleness window. The reconciler leases uncertain rows and uses only `fetch_all_orders`,
`fetch_all_payment_links`, or `fetch_payment`. It reads after injected 250 ms, 500 ms, and 1,000 ms
delays, then keeps the reservation charged, records an escalation, and schedules a later retry when
the result is still uncertain. Missing entities never release budget. A confirmed `failed` payment
is the only read result that releases an uncertain capture.

Start the webhook intake after setting `WEBHOOK_SECRET`:

```powershell
npm run dev
```

Export and verify the audit ledger:

```powershell
npm run export:ledger
npm run verify:ledger
```

Build, verify, and score a sanitized proof bundle:

```powershell
npm run evidence -- build --output evidence/bundle
npm run evidence -- verify evidence/bundle/manifest.json
npm run evidence -- score evidence/bundle/manifest.json
```

Use `--created-at <ISO-8601>` when a specific reproducible creation time is required. Without it,
the builder uses the checked-out commit time, so identical inputs remain byte-identical. The build
runs the test suite, TypeScript compiler, dependency audit, and diff check; it copies only canonical
sanitized JSON summaries into the bundle. Every item is labelled as real Test Mode, mocked Gemini,
deterministic fake, synthetic chaos, local verification, or pending external replay. Missing genuine
webhook evidence stays `PENDING_EXTERNAL_REPLAY` and cannot be relabelled by the verifier. The
manifest records whether the commit had uncommitted changes when the bundle was built.

Run a Counterfactual Lab scenario without contacting Razorpay:

```powershell
npm run lab -- run scenarios/lab/timeout-after-acceptance.json
npm run lab -- replay scenarios/lab/webhook-reconciler-race.json --seed 808
npm run lab -- explore campaigns/lab/unsafe-retry.json
npm run lab -- reproduce regressions/lab/unsafe-retry-discovery-one_intent_one_effect.json
```

`run` uses the seed stored in a scenario. `replay` requires an explicit seed, so a reported run can
be repeated without silently using a different schedule. Both commands validate the versioned JSON
event stream, order equal-time events deterministically, reduce it from a clean virtual clock, and
print a canonical report. The eight checked-in scenarios cover timeout after acceptance, duplicate
and out-of-order webhooks, retry, crash and restart, revocation during dispatch, a malformed read,
and a webhook racing the reconciler.

`explore` starts from a compact workflow and fault list rather than an authored event order. It
walks valid equal-time interleavings within explicit event, schedule, depth, and runtime limits,
prunes equivalent normalized states, and minimizes the first failure for each invariant. The
checked-in unsafe retry campaign independently finds a one-intent/two-effect failure and writes a
versioned regression fixture. `reproduce` runs that fixture against both the deliberately unsafe
reference model and the guarded IntentProof model. Every Lab command uses the in-memory fake
provider only; none has a Razorpay transport.

## Scope

The MVP supports `create_order`, `create_payment_link`, and `capture_payment`. Every other mutating
tool fails closed. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the enforcement path and
[SAFETY.md](./SAFETY.md) for its limits.

## Open Track Fit

- **Real problem:** the public agent surface has no documented merchant-intent layer for contextual ceilings, rolling value limits, evidence-dependent capture, or human approval.
- **Meaningful AI:** an LLM drafts rules from merchant English and drives the demo agent; deterministic code makes every enforcement decision.
- **Working product:** the gateway, webhook intake, audit export, and verifier run locally against Razorpay Test Mode.
- **Evidence of value:** clean-control pass rate, false blocks, simulated value blocked, in-doubt outcomes, duplicate effects prevented, latency, and remaining leaks are measured.
- **Reliability and depth:** raw-byte signature verification, transactional state, scoped idempotency, fail-closed uncertainty, adversarial fixtures, and tamper localization are tested.

## Where IntentProof Still Leaks

- The pinned MCP image exposes the required receipt, reference-ID, and payment-ID read filters, but
  it publishes no output schema. IntentProof therefore accepts only the explicit response shapes it
  validates and leaves every other shape `IN_DOUBT`.
- Razorpay read-after-write timing and payment-link pagination behavior are not verified. Empty,
  delayed, contradictory, or ambiguous reads stay charged and require later retry or human review.
- Idempotency is enforced by this SQLite store. It is not a global exactly-once guarantee.
- Counterfactual Lab is a deterministic model, not a Razorpay conformance test or a proof of every
  possible execution. Exploration is bounded, in-memory, and limited to the modeled actions and
  faults; state pruning relies on the documented normalized projection.
- The compiler accepts only the frozen rule vocabulary. Its deterministic fake recognizes the demo
  phrasing, while Gemini output remains untrusted until schema, source-coverage, quote, and human
  review checks pass. This is not a general natural-language policy language.
- Human approval is a local CLI identity and immutable file write, not strong user authentication or
  a digital signature. A compromised host can still replace the mandate supplied at startup.
- The planner is intentionally narrow and stateless. Sensitive or payment-event-shaped objectives
  fail closed instead of being sent to Gemini, so trusted payment identifiers must come from a
  separate deterministic workflow rather than free-form model input.
- Structured generation guides Gemini, but every response remains untrusted and must pass the local
  strict schema. The deterministic fake covers repeatable tests; no live-model reliability claim is
  made by the automated suite.
- Evidence-bundle hashes detect changes but do not authenticate an author or prove provider origin.
  The scoreboard reports only repository-derived metrics, and a pending provider replay stays
  visibly pending rather than being replaced by fixture evidence.
- The final kill-switch and mandate-version check runs in the transaction that claims a reservation.
  The network call starts immediately after that transaction, so a host failure in that narrow gap
  still requires reconciliation.
