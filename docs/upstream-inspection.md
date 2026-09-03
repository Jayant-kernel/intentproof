# Upstream inspection

Inspected on 2026-09-02 before implementing the gateway:

- Installed SDK: `@modelcontextprotocol/client` and `@modelcontextprotocol/server` 2.0.0.
- Local image: `razorpay/mcp:latest`, image ID prefix `435109006d62`, created 2025-09-26.
- The image entrypoint runs `razorpay-mcp-server stdio` and takes credentials from
  `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
- Official source definitions use integer-paise `amount`; capture requires `payment_id`, `amount`,
  and `currency`.
- IntentProof intentionally omits upstream order-transfer and recurring-mandate fields from its
  exposed schema because they are outside the frozen MVP.
- A Docker stdio probe with synthetic placeholders completed MCP initialization and listed 41 tools.
- The probe called `fetch_all_payments` with `count: 1`; authentication failed as expected because
  the values were placeholders. This proves the call path and error handling, not a successful
  Razorpay Test Mode read.

On 2026-09-03, the credentialed probe started the Docker server, listed 41 tools, and completed a
read-only `fetch_all_payments` call. The saved evidence contains the tool names and success status,
but no response body, credentials, or payment data.

The pinned image was inspected again for reconciliation with synthetic placeholders and without
making a Razorpay API call. Its advertised input schemas include `fetch_all_orders.receipt`,
`fetch_all_payment_links.reference_id`, and `fetch_payment.payment_id`. Those three names form the
complete reconciliation read allowlist.

The following assumptions remain **NOT VERIFIED** because the image advertises no output schemas and
no real reconciliation read was made:

- the exact JSON wrapper and required fields returned by successful read and mutation tools;
- whether the advertised receipt and reference-ID filters behave as exact server-side filters;
- Razorpay read-after-write visibility after an uncertain mutation;
- whether a filtered order collection can still be pagination-ambiguous;
- the payment-link collection wrapper and its count or pagination behavior;
- whether a just-captured payment can temporarily read as `authorized`.

IntentProof handles each unknown by retaining `IN_DOUBT`. It does not treat an empty collection,
404, parse failure, or free-form status text as proof that a mutation failed.

The next probe sent one ₹1 order through the IntentProof MCP gateway. It was allowed and executed
once. BLOCK, HOLD_FOR_APPROVAL, and ABSTAIN were then evaluated in the same process, and each added
zero calls at the upstream boundary. The order response was discarded. After this first successful
pass-through, the image was pinned to
`razorpay/mcp@sha256:435109006d6247103899938cf7b1747ba8be1c1a8a28d452cf9fa8eff506e5c6`.
