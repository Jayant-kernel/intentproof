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
- The LLM compiler may draft and explain configuration only. It cannot return policy verdicts,
  activate a mandate, change an approved version, release budget, settle an effect, or call a payment
  provider.
- Drafts and approved mandates use different schemas. Only an explicitly approved, hash-valid
  mandate can be loaded for enforcement, and approved version files are written create-once.
- Compiler prompts contain only redacted merchant instructions. Known credential, provider-entity,
  email, card-number, phone-number, and financial-event shapes are removed and make the draft
  non-approvable.
- Redaction is defense in depth, not a complete sensitive-data classifier. Merchants must provide
  policy text only, and Gemini compilation must never receive real customer or payment data.
- The demo agent has only the three gateway tools and no direct upstream client. Its default run uses
  a deterministic fake upstream and synthetic identifiers.
- The model planner can emit only a strict four-field proposal for three mutations or `no_action`.
  It cannot emit a verdict, approval, mandate change, provider request, or arbitrary tool name.
- Planner providers receive no gateway, MCP, dispatcher, upstream client, policy state, approval
  state, or Razorpay credential. The live Gemini smoke command is planning-only and has no execution
  dependency.
- Sensitive or payment-event-shaped objectives are rejected before a provider call. Model output is
  byte-limited, parsed as untrusted JSON, checked for sensitive explanation text, and validated twice
  before the gateway sees it: once as a planner proposal and once as gateway arguments.
- Prompt instructions cannot expand the hard-coded proposal union. Invalid output makes no gateway
  call; `BLOCK`, `HOLD_FOR_APPROVAL`, and `ABSTAIN` make no upstream call.
- Redaction patterns and prompt delimiting are defense in depth, not a proof that arbitrary prose is
  free of sensitive data. Operators must use synthetic objectives for live-model smoke testing.
- CLI approval records an asserted local identity; it is not authentication, a signature, or
  protection against a compromised host.
- No failure story is published unless it was observed during development.
