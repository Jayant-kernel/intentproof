# Safety

- Razorpay Test Mode only.
- No live keys, real money, or production probing.
- Secrets remain in the ignored `.env` file.
- Real customer and merchant data never goes to an LLM.
- Adversarial traffic targets only this local gateway and its test fixtures.
- The audit export is tamper-evident, not tamper-proof.
- At-most-once claims are scoped to this process and this local store.
- `IN_DOUBT` reservations continue consuming budget until a later reconciliation resolves them.
- Production MCP error prose never releases capacity. Mutation success needs a tool-specific parsed
  response; every MCP error, exception, malformed response, or missing success field is uncertain.
- Reconciliation is read-only. Empty results, 404 responses, stale authorized payments, exhausted
  attempts, and old reservations remain charged. They are scheduled again and marked for human
  review rather than released by age or retry count.
- Only a positively observed terminal `failed` capture releases uncertain budget. Deterministic fake
  dispatchers may still return a definitive failure to test the generic executor transition.
- Reconciliation leases and terminal changes are scoped to the local SQLite database. They do not
  establish exactly-once network delivery.
- Counterfactual Lab uses an in-memory fake provider and a virtual clock. It cannot call Razorpay,
  and its scenarios contain no credentials or real payment data.
- The Lab reducer and invariant checks are deterministic code. No LLM authorizes a call, settles an
  effect, validates a signature, releases budget, or decides whether an invariant passed.
- Schedule exploration is bounded and covers only the fake provider, modeled faults, and partial
  orders in each campaign. It is not exhaustive verification or provider API conformance.
- The unsafe reference model exists only inside the Lab. Its minimized failure fixtures are
  synthetic and cannot reach the production gateway or a network transport.
- The Lab has no dashboard, production persistence, LLM agent, or proof-bundle generator.
- No failure story is published unless it was observed during development.
