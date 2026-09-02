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

The next probe sent one ₹1 order through the IntentProof MCP gateway. It was allowed and executed
once. BLOCK, HOLD_FOR_APPROVAL, and ABSTAIN were then evaluated in the same process, and each added
zero calls at the upstream boundary. The order response was discarded. After this first successful
pass-through, the image was pinned to
`razorpay/mcp@sha256:435109006d6247103899938cf7b1747ba8be1c1a8a28d452cf9fa8eff506e5c6`.
