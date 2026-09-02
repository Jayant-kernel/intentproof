# Safety

- Razorpay Test Mode only.
- No live keys, real money, or production probing.
- Secrets remain in the ignored `.env` file.
- Real customer and merchant data never goes to an LLM.
- Adversarial traffic targets only this local gateway and its test fixtures.
- The audit export is tamper-evident, not tamper-proof.
- At-most-once claims are scoped to this process and this local store.
- `IN_DOUBT` reservations continue consuming budget until a later reconciliation resolves them.
- A definitive rejection releases capacity; an unknown error never does.
- No failure story is published unless it was observed during development.
