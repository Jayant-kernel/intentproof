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
- [ ] Real Razorpay Test Mode webhook.
- [x] Successful credentialed `fetch_all_payments` read evidence with response data omitted.
- [x] One INR 1 Test Mode order passed through the gateway; each non-`ALLOW` verdict made zero upstream calls.
- [x] Transactional `RESERVED`, `COMMITTED`, `RELEASED`, and `IN_DOUBT` executor lifecycle.
- [x] SQLite-backed idempotency and dispatch-time kill-switch/version checks.
- [ ] Bounded read-back and reconciliation for `IN_DOUBT` reservations.
- [ ] Offline LLM mandate compiler with human approval.

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm test
npm run build
```

Fill `.env` locally. Never commit it.

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
state and never dispatches again.

Start the webhook intake after setting `WEBHOOK_SECRET`:

```powershell
npm run dev
```

Export and verify the audit ledger:

```powershell
npm run export:ledger
npm run verify:ledger
```

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

- `IN_DOUBT` reservations stay charged to the rolling budget, but there is no read-back reconciler yet.
- Idempotency is enforced by this SQLite store. It is not a global exactly-once guarantee.
- The final kill-switch and mandate-version check runs in the transaction that claims a reservation.
  The network call starts immediately after that transaction, so a host failure in that narrow gap
  still requires reconciliation.
