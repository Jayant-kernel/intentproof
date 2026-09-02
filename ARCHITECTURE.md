# Architecture

IntentProof has two controlled inputs in one codebase:

1. Agent MCP tool calls, checked before any supported mutation reaches Razorpay.
2. Razorpay webhooks, verified from raw bytes before parsing and applied transactionally.

SQLite is transactional truth. The JSONL ledger is a canonical, tamper-evident export generated from committed audit rows. Synthetic chaos events and real Test Mode events use the same webhook handler.

The LLM drafts rules and explains traces offline. Deterministic code owns every enforcement decision.

The MCP path is split behind an `UpstreamClient` interface. Production startup launches the official
`razorpay/mcp` image through Docker stdio using the installed MCP client SDK. The gateway itself is a
separate MCP server and registers only the three frozen tools. Its strict Zod schemas and policy check
run before the upstream interface, which lets integration tests prove that every non-`ALLOW` verdict
causes zero upstream calls.

Credentials are passed to Docker through its child environment, never command-line arguments. Both
thrown transport errors and MCP tool-error results are recursively sanitized before they can reach an
agent or the audit store.

## Budget and dispatch

An allowed mutation moves through four persisted states:

1. An immediate SQLite transaction checks the rolling call and value limits, inserts a unique
   idempotency key, and writes `BUDGET_RESERVED`.
2. A second immediate transaction checks the current kill switch, mandate version, reservation state,
   and whether another worker already claimed the key. Only then does it mark dispatch as started.
3. The executor makes the upstream call. A confirmed success commits the reservation; a definitive
   rejection releases it; a timeout or ambiguous result leaves it `IN_DOUBT`.
4. Settlement and its audit record commit in one SQLite transaction.

`RESERVED`, `COMMITTED`, and `IN_DOUBT` all consume capacity. `RELEASED` does not. A repeated
idempotency key returns its stored state without another upstream call. When the caller supplies no
key, the fallback is a hash of the mandate, agent, tool, canonical arguments, and a five-minute time
bucket. This is useful for immediate retries, but callers that can identify a business operation
should always supply their own stable key.

The current safety limits and deliberately narrow claims are documented in [SAFETY.md](./SAFETY.md).
