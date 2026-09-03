# Failure Log

Record only failures observed while building or testing IntentProof.

| Date | Failure | Evidence | Root cause | Fix | Regression test |
|---|---|---|---|---|---|
| 2026-09-02 | `npm ci` tried to rebuild `better-sqlite3` and failed. | Local install output named the missing Python prerequisite. | This Windows machine had no usable Python for `node-gyp`. | Restored the locked dependencies without lifecycle scripts; the existing native binding remained usable. A clean native rebuild still needs machine setup. | Full tests and TypeScript build run after every milestone. |
| 2026-09-03 | The first credentialed Razorpay read returned HTTP 401. | The probe stored only the `authentication` category. | The local Test Mode key pair was rejected; no secret was logged. | Replaced the local key pair and reran the read-only probe. | `fetch_all_payments` succeeded; sanitized evidence retains no response body. |
| 2026-09-03 | MCP error prose containing HTTP-like numbers could be classified as a definitive failure. | The dispatcher used a status-code regular expression over free text. | Free text cannot prove financial state and could contain an echoed amount, receipt, or unrelated code. | Production classification now requires a parsed tool-specific success shape; all MCP errors and unparseable responses are uncertain. | Parameterized tests cover 400, 401, 403, 404, 409, and 422 text. |
