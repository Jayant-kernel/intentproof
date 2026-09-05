# IntentProof — Buildathon video production packet

Prepared against the local implementation and evidence inspected on 5 September 2026. Deliverables: a five-minute submission storyboard, a two-minute cut, recording instructions, claim sources, overlays, and recording checklist. This packet scripts footage; it is not a rendered video.

## Editorial premise and verified scope

**Central line:** “An AI agent can propose a payment. IntentProof checks whether it has the authority to execute it.”

Use one illustrative merchant throughout: a small online shop whose approved mandate permits orders up to ₹3,000. The simulated agent proposes an order for **300001 paise (₹3,000.01)**. The actual implemented outcome is **BLOCK**, rule **C2**, quotation **“Create orders up to 3,000 rupees.”**, **one gateway call and zero upstream calls**. The shop then requests a separate, permitted **19900-paise (₹199)** order: **ALLOW**, one gateway call, one **fake-provider** call. Creating an order is not capturing funds or completing a payment.

The shop is an illustrative scenario, not an existing customer. The mistake is a fixture/overlay, not an observed live-model failure. Do not describe the second order as a retry of the first or show the same intent identifier for both.

The browser currently uses a deterministic fake compiler, deterministic fake planner, and fake upstream. Its decisions are produced by the implemented policy engine; the audit rows are records of those local runs, not decorative hardcoded rows. The Gemini adapter exists, but the inspected planner evidence is MOCKED_GEMINI. No verified recording of live Gemini behavior was found among the inspected evidence.

Important implementation distinctions:

- `ControlRoomService.runAgent()` creates a gateway without the optional transactional executor. Its policy context fixes the evaluation time and supplies zero rolling usage. The UI run demonstrates policy enforcement and a fake dispatch, not end-to-end transactional budget reservation or reconciliation. Show those separately through executor evidence and Lab fixtures.
- The Lab's selected timeline comes from the selected scenario. Its comparison panel always reproduces the separate saved unsafe-retry regression. Never narrate them as one identical trace.
- Audit **Verify Ledger** verifies repository `ledger.jsonl`, not the live Control Room rows. The local chain continuity display checks adjacent hashes. Neither statement establishes provider identity.
- The evidence bundle contains **11 hashed artifacts and 10 evidence-register entries**. Its test count is a historical snapshot: 163 tests across 25 files. Do not relabel it with the prior development run's 182 tests.
- The genuine webhook slot remains **PENDING_EXTERNAL_REPLAY**. A saved ₹1 Razorpay Test Mode order is separate evidence and does not verify webhook delivery.

## Five-minute production table

Target: 05:00 including cursor dwell and transitions. Read naturally at approximately 125–140 words per minute during spoken segments. Leave the remaining time for inspecting labels. Record narration by timed row; shorten pauses before speeding up speech. Text in quotation marks in the right column is the exact narration; bracketed directions are silent.

| Timestamp, screen/shot, cursor action, overlay | Exact spoken script, audio cue, transition |
| --- | --- |
| **0:00–0:10 — Simulated proposal.** Clean full-screen editorial overlay, not a fabricated app screen. Show “Merchant limit: ₹3,000” followed by “Proposed order: ₹3,000.01”. Persistent label: “SIMULATED PROPOSAL · DETERMINISTIC FIXTURE”. Cursor underlines the extra paisa once. | “The shop owner approved orders up to three thousand rupees. The agent asks for three thousand and one paisa. Small difference. Different authority.” [One quiet click as the proposal appears. No alarm.] |
| **0:10–0:20 — Product reveal.** Cut directly to the actual Control Room. Overlay the central sentence in two readable lines. Keep product branding visible. | “Valid JSON has excellent punctuation. It still needs permission. An AI agent can propose a payment. IntentProof checks whether it has the authority to execute it.” [Brief half-beat after the joke. Clean cut; understated instrumental bed begins.] |
| **0:20–0:45 — Problem and user.** Overview, then Mandate. Cursor passes the order ceiling, budget, delivery precondition, and approval gate without clicking controls. Overlay: “Schema validity ≠ merchant authority”. | “For a merchant delegating payment work to an agent, a well-formed request is only the beginning. It can still exceed an approved amount, lack delivery evidence, or require human approval. IntentProof puts the merchant's approved rules at the execution boundary, where those requests become decisions.” [Hold each relevant row long enough to read. No simulated loss counter.] |
| **0:45–1:05 — Approved mandate.** Mandate screen: frame APPROVED v1, Active Version, and C2 in Approved Rules. If Draft v2 is visible, show its “not active” wording. Overlay: “Active authority: approved v1”. | “Here is our shop's approved mandate, version one. Rule C2 says: ‘Create orders up to three thousand rupees.’ Drafts stay inactive until explicit approval. The existing draft does not replace this approved version.” [Cursor rests beside C2. Straight cut to Agent.] |
| **1:05–1:25 — Proposal and confirmation.** Click **Over-limit order**. Hold the confirmation dialog, then click **Run Through Gateway**. Show the sanitized proposal envelope, including 300001 paise. Overlay: “₹3,000.01 = 300001 paise · FAKE PLANNER”. | “I select the over-limit example. It proposes an order for three hundred thousand and one paise. This recording uses a deterministic fake planner and provider. The gateway still runs the implemented validation and policy checks. Let's submit it.” [Retain the actual response wait. No fabricated progress animation.] |
| **1:25–1:45 — Verdict proof.** Frame **Action Blocked**, **BLOCK**, C2, the exact quotation, **Gateway Calls 1**, and **Upstream Calls 0**. Click the rule link briefly to show highlighted C2, then return to Agent. Capture the result before navigating because the result view resets on navigation. | “Blocked. C2 supplies the reason and the exact merchant quotation. One gateway call; zero upstream calls. The request reached the policy boundary and stopped there. That zero is the result of this run, not an estimate of money saved.” [Music ducks. Hold zero upstream calls for three seconds.] |
| **1:45–2:05 — Permitted order.** On Agent click **Allowed ₹199 order**, confirm **Run Through Gateway**. Frame **Action May Proceed**, **ALLOW**, both per-run counters, and sanitized proposal. Overlay: “SEPARATE ₹199 ORDER · FAKE PROVIDER · NO RAZORPAY TRANSACTION”. | “Now the same shop requests a separate order for one hundred and ninety-nine rupees. This proposal passes the active checks. ALLOW, with one fake-provider call. We have demonstrated an order request passing policy; we have not charged a customer.” [Gentle confirmation click. Keep provenance visible.] |
| **2:05–2:30 — Audit and AI boundary.** Audit: expand the newest **Tool Executed** row from this take, then frame the matching **Tool Allowed** row. Overlay: “Recorded local execution · inspectable hash linkage”. Brief insert of the planner artifact labeled MOCKED_GEMINI. | “The audit records the allowed decision and fake execution. Expand the record to inspect its context and hash linkage. The AI role is proposing actions and drafting rules. Gemini adapters implement that role, but this UI uses fixtures, and the saved Gemini validation evidence uses mocked responses. Deterministic code decides authority.” [Slow cursor movement; straight cut into Lab.] |
| **2:30–2:50 — Timeout timeline.** Lab: choose **Agent retry after timeout · 8 events**, click **Replay**. Select event 5, then 6, 7, 8: send, timeout, repeated request, reconciliation read. Overlay: “SYNTHETIC CHAOS · retry scenario · seed 404”. | “Now consider uncertainty. A timeout does not tell us whether a remote action happened. This synthetic retry scenario sends once, observes a timeout, receives the same request again, and gets an empty reconciliation read. The modeled operation remains in doubt.” [Soft transition, no crash sound. Do not call this timeline an after-acceptance trace.] |
| **2:50–3:10 — Unsafe retry counterexample.** Frame Lab comparison panel. Overlay: “SEPARATE SAVED REGRESSION · seed 2909”. Insert a legible excerpt of the fresh CLI reproduction: fixture ID, reproduced true, unsafe passed false, IntentProof passed true. | “The comparison above is a separate saved retry counterexample. In its deliberately unsafe model, one intent produces duplicate effects. Replaying the same fixture makes that model fail and the IntentProof model pass. We can reproduce the failure instead of merely describing it.” [Hold the two results side by side. Never suggest the timeline below is this exact fixture.] |
| **3:10–3:30 — Failure handling and limits.** Show the executor-lifecycle timeout and retry artifact fields, then Lab invariant results. Overlay: “IN_DOUBT stays charged · bounded model evidence”. | “Separate executor tests show uncertain reservations staying charged, and a retry making no additional upstream call after timeout. The reconciler uses reads to seek a confirmed outcome. These are bounded models and local tests. They do not prove every possible production behavior.” [Plain cut. No implication that the UI order updated these artifact values.] |
| **3:30–3:55 — Architecture.** Simple static two-lane graphic: Merchant instruction → draft → explicit approval → approved mandate; agent objective → proposal → deterministic gateway → permitted execution → audit/evidence. Draw approved mandate feeding the gateway. Add an executor branch: reserve → dispatch → commit / release / in doubt → read-only reconciliation. Overlay: “UI footage: fake execution · executor behavior: separate tested path”. | “The architecture separates proposal from authority. Merchant instructions become a draft; explicit approval establishes the mandate. An agent proposal reaches the deterministic gateway. The transactional execution path reserves capacity and tracks confirmed, failed, or uncertain outcomes. Audit and evidence make those decisions inspectable. A model cannot grant itself permission.” [Reveal each lane once using restrained fades. Keep the diagram on screen, not decorative footage.] |
| **3:55–4:20 — Evidence provenance.** Evidence: select **Mocked Gemini**, **Real Razorpay Test Mode**, and **Pending External Replay**. Brief artifact insert shows 100 paise for the saved order. Finish with PENDING row and top command status. | “The evidence register separates deterministic fixtures, mocked Gemini, synthetic chaos, and real Test Mode evidence. A saved artifact records one permitted one-rupee Razorpay Test Mode order. That is distinct from today's fake execution, and it is not webhook proof. Genuine webhook replay remains visibly pending.” [Hold pending label at least three seconds. Do not imply the video initiated the saved order.] |
| **4:20–4:40 — Demonstrated value.** Replay short excerpts from this take: C2 quotation plus zero upstream calls; permitted fake run; reproduced regression result. Overlay: “Rule-linked BLOCK · 0 upstream calls · reproducible retry counterexample”. | “For this merchant, we demonstrated a request outside the approved ceiling stopping before dispatch, a permitted request reaching the fake provider, and an audit trail for inspection. We also reproduced an unsafe retry failure. Each result has a specific rule, run, or artifact behind it.” [Music rises slightly, voice remains clear.] |
| **4:40–5:00 — Close.** Return to Overview with unresolved replay visible. Final end card: IntentProof; repository address; “Recorded local Control Room demo”. Keep the end card visible for the final five seconds. | “The remaining boundary matters: genuine webhook replay is still pending, and local idempotency is not a universal exactly-once guarantee. Explore the repository and this recorded local demo. IntentProof: the agent proposes; the merchant's approved authority governs execution.” [Bed fades out. No unverified deployment link.] |

## Two-minute promotional cut

Use the same takes and results. Do not create a new story, change the amounts, or strip provenance labels. Target 02:00 including short visual holds.

| Timestamp, screen/shot, cursor action, overlay | Exact spoken script, audio cue, transition |
| --- | --- |
| **0:00–0:12.** Reuse simulated limit/proposal overlay, then Control Room reveal. Label SIMULATED PROPOSAL throughout the overlay. | “The merchant approved orders up to three thousand rupees. The agent asks for three thousand and one paisa. Valid JSON. Wrong authority.” [One click; cut to product.] |
| **0:12–0:27.** Approved v1 and C2 quotation; cursor points to the rule. | “An AI agent can propose a payment. IntentProof checks whether it has the authority to execute it. Here, the merchant's approved mandate sets the order ceiling.” [Quiet music bed.] |
| **0:27–0:45.** Reuse over-limit confirmation and BLOCK proof; hold zero upstream calls. Label FAKE PLANNER + FAKE PROVIDER. | “This deterministic fixture requests three hundred thousand and one paise. The implemented gateway returns BLOCK, identifies C2, and shows the exact rule. One gateway call. Zero upstream calls.” [Duck music at zero.] |
| **0:45–1:00.** ₹199 ALLOW, fake-provider counter, expanded audit row. | “A separate one-hundred-and-ninety-nine-rupee order passes. One fake-provider call, with an inspectable audit record. This is local demo execution; no customer has been charged.” [Straight cuts.] |
| **1:00–1:20.** Reuse unsafe-regression comparison and CLI excerpt only. Label SYNTHETIC CHAOS · SAVED REGRESSION. Do not intercut the different selectable timeline. | “And when a request times out? Retrying can create duplicate effects. Our saved counterexample reproduces that failure in an unsafe model, while the IntentProof model passes. The result is reproducible, within the modeled boundary.” [Hold PASS/FAIL text.] |
| **1:20–1:40.** Reuse architecture graphic and Mocked Gemini / Real Test Mode / Pending filters. | “AI proposes; deterministic code decides. This UI uses fixtures, and Gemini validation evidence is mocked. Provenance stays visible. A saved one-rupee Test Mode order is separate evidence; genuine webhook replay is still pending.” [No celebratory webhook graphic.] |
| **1:40–2:00.** C2 zero-call proof, pending label, then repository end card. | “The demonstrated value: explicit authority, blocked dispatch, and evidence you can inspect. Local tests do not guarantee universal payment safety. See the repository and recorded demo. IntentProof: the agent proposes; approved merchant rules govern execution.” [Fade out; five-second end-card hold.] |

## Recording preparation and exact runbook

### Starting state

Use the existing local frontend at `http://127.0.0.1:4173/#overview`. All six screens loaded during this inspection. The active mandate was v1, kill switch OFF, and an inert Draft v2 existed. The local audit had 156 records; these are prior demo runs, not transactions or customers. Do not script a fixed audit count, sequence number, hash, timestamp, or verdict-distribution total.

Use a clean browser window or application-only capture. Record at 1920×1080, with app/browser zoom adjusted so quotations and call counts remain readable in the delivered 1080p video. Test the final encoding at normal playback size. Do not use the original screenshot's personal browser tabs as footage.

Keep the existing draft inactive. The main take reads approved v1 and does not require generating or approving a mandate. If active version or rule text differs at recording time, stop that take and check the state; never edit an overlay to contradict the actual screen.

### Commands

Run from the repository root. The two existing servers are already available; no server restart is necessary for this recording plan. Do not run `npm start` on an occupied port. Do not stop, restart, modify, or reuse the protected webhook listener or zrok process.

Read-only checks and local isolated verification:

```powershell
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -in 4173,8787 } |
  Select-Object LocalAddress,LocalPort,OwningProcess

npx vitest run tests/control-room-api.spec.ts tests/lab-model-comparison.spec.ts tests/executor.spec.ts tests/planner.spec.ts
npm run evidence -- verify evidence/bundle/manifest.json
npm run lab -- replay scenarios/lab/retry.json --seed 404
npm run lab -- reproduce regressions/lab/unsafe-retry-discovery-one_intent_one_effect.json
```

The fresh checks for this packet returned 43 passing tests across four files; bundle verification returned `valid: true`, `artifacts: 11`; retry replay returned eight events, `passed: true`, `IN_DOUBT`, one mutation attempt, two requests, and `budgetCharged: true`; regression reproduction returned `reproduced: true`, unsafe `passed: false`, IntentProof `passed: true`.

For a readable terminal insert, use the existing CLI and select its real output fields, without changing the fixture or inventing results:

```powershell
$demoRegressionLines = npm run lab -- reproduce regressions/lab/unsafe-retry-discovery-one_intent_one_effect.json
$demoRegression = ($demoRegressionLines | Where-Object { $_ -match '^\{' }) | ConvertFrom-Json
$demoRegression | Select-Object fixture_id,invariant_id,reproduced
$demoRegression.unsafe_reference | Select-Object passed
$demoRegression.intentproof | Select-Object passed
```

Label the two final outputs “Unsafe reference” and “IntentProof” in the editorial overlay so identical `passed` column names cannot be confused. Capture the command as well as the result. Do not crop away a failing exit or error.

No model/network call is required. Do not run `probe:gateway`, `probe:upstream`, `planner:smoke`, any Gemini-provider command, or webhook replay tooling for this video. Do not rebuild or overwrite the evidence bundle merely to obtain fresher-looking numbers.

### Exact inputs and expected results

| Step | Actual input/control | Expected result and recording instruction |
| --- | --- | --- |
| Read authority | Mandate → Approved Rules → C2 | Approved v1; ceiling 300000 paise; quotation “Create orders up to 3,000 rupees.” |
| Block | Agent → **Over-limit order** → **Run Through Gateway** | Fixture objective `Create an order for 300001 paise.`; `create_order`; BLOCK; C2; gateway 1; upstream 0. The example button supplies the fixture objective even if the text field still shows its default objective. Frame the result/proposal, not the default field as if it were the submitted input. |
| Inspect rule | Result C2 link | Mandate opens with the approved C2 row highlighted. Capture the verdict before leaving Agent; navigating away resets its result panel. |
| Allow | Agent → **Allowed ₹199 order** → **Run Through Gateway** | Fixture objective `Create an order for 19900 paise.`; ALLOW; gateway 1; upstream 1, fake only. This is a separate order. |
| Audit | Audit → expand newest **Tool Executed** row from this take | “fake upstream called”; hash and previous hash visible. Match the take's timestamp/sequence; do not expand an arbitrary historical row. Nearby **Tool Allowed** is the decision record. |
| Retry timeline | Lab → **Agent retry after timeout · 8 events** → Replay | `retry`, seed 404; all scenario invariants pass. Select range values 4, 5, 6, 7 (displayed events 5–8). Types: PROVIDER_MUTATION_SENT, TIMEOUT_OBSERVED, AGENT_TOOL_REQUESTED, RECONCILIATION_READ. |
| Counterexample | Lab comparison + CLI reproduction | Separate fixture `unsafe-retry-discovery-one_intent_one_effect`; seed 2909; ONE_INTENT_ONE_EFFECT fails in unsafe reference, passes in IntentProof. |
| Provenance | Evidence → Mocked Gemini → Real Razorpay Test Mode → Pending External Replay | One evidence entry in each filter. Pending stays PENDING. Bundle contains 11 artifacts, register contains 10 entries. |

Optional alternate capture fixture, **not used in the main script**: clicking **Capture before delivery** supplies `deliveryConfirmed: false` and returns BLOCK/C3 for `Capture 100000 paise.` Typing that same objective manually leaves delivery evidence unknown and returns ABSTAIN. **Approval-required capture** supplies confirmed delivery at 250000 paise and returns HOLD_FOR_APPROVAL/C4. Do not claim that delivery confirmation alone permits capture.

### Reset and retake procedure

1. Cancel any open confirmation. Return to `/#overview`, then navigate to Agent for the next take. A page reload resets client result panels, audit expansion, filters, and Lab selection; it does not clear stored audit records, approve a draft, or reset server controls.
2. Check v1 and kill switch OFF again. If controls changed unexpectedly, end the take and identify the change. This storyboard never asks you to toggle the switch or approve Draft v2.
3. Re-run only the intended fake example when recording. Each retake can append additional local audit rows. Use the newest matching timestamp and action. Preserve old evidence; no database deletion or audit reset is needed.
4. Lab CLI reproduction starts from the fixture's clean model state each time. Re-running the command is its reset; no service restart is involved.
5. Keep a take log outside the captured screen: blocked result time, allowed result time, audit sequence, and filenames. Do not hardcode these evolving values in the script.

Record the main screen sequence as: Overview → Mandate approved C2 → Agent over-limit → Mandate highlighted C2 → Agent allowed order → Audit → Lab retry timeline → separate regression terminal insert → Evidence filters → Overview → end card. Capture the architecture and simulated proposal as editorial assets, not modifications to the application.

## Claim-to-evidence register

Paths are relative to the repository root. “Fresh verification” describes checks run for this packet; “saved evidence” describes a checked-in artifact, not a new provider transaction.

| Spoken or visual claim | Supporting source | Status / boundary |
| --- | --- | --- |
| Approved v1 sets ₹3,000 order ceiling, rule C2 | `mandates/default.yaml`; `src/policy/evaluate.ts`; live Mandate screen | Inspected source and current screen. |
| ₹3,000.01 is blocked before upstream dispatch | `src/control-room/service.ts` examples and `runAgent`; `tests/control-room-api.spec.ts` verdict matrix; `mandates/default.yaml` C2 | Fresh API test suite passed in isolated memory. Record the actual UI result for the video. No new UI action run during packet preparation. |
| ₹199 order is allowed with one fake call | Same service and API test matrix | Fresh tests; fake provider. Not a funds capture or Razorpay transaction. |
| Browser examples use fake planning and execution | `src/control-room/service.ts` imports/instantiates DeterministicFakePlanner and FakeUpstream | Verified implementation, not live Gemini. |
| Model-backed proposal generation exists | `src/planner/gemini-planner.ts`; `src/llm/gemini-compiler.ts`; planner/compiler validation modules | Adapter implementation exists. Successful live-model recording **unverified** in inspected evidence. |
| Mocked Gemini validation covers constrained proposals | `evidence/bundle/artifacts/planner-validation.json`; `tests/planner.spec.ts` | Saved MOCKED_GEMINI artifact; fresh focused planner tests passed. No model reliability percentage. |
| Draft requires explicit approval to become authority | `src/mandate/artifacts.ts`; `tests/control-room-api.spec.ts`; `evidence/bundle/artifacts/mandate-approval.json` | Fresh draft/approval API test; recorded UI starts from already-approved v1. No approval action needed in take. |
| Audit records include verdict, rule, and hash linkage | `src/control-room/service.ts` audit mapping; `src/ledger/exporter.ts`; `web/src/App.tsx` AuditRows | Current local records inspected. Hashes indicate integrity, not authenticity or provider identity. |
| Local chain and repository ledger are different checks | `web/src/App.tsx` auditContinuity; service `verifyLedger`; `src/ledger/verify.ts` | Code verified. Do not present Verify Ledger as verification of every displayed live row. |
| Non-ALLOW paths make zero upstream calls in covered cases | `evidence/bundle/artifacts/non-allow-zero-calls.json`; `tests/gateway-integration.spec.ts`; API verdict matrix | Saved BLOCK/HOLD/ABSTAIN evidence plus fresh API tests. Scoped to tested gateway paths. |
| Transactional reservation / committed / released / in-doubt states | `src/executor/`; `tests/executor.spec.ts`; `evidence/bundle/artifacts/executor-lifecycle.json` | Fresh executor tests passed; saved fake-upstream lifecycle evidence. Control Room's basic action path does not demonstrate this executor integration. |
| Uncertainty stays charged; read-only reconciliation seeks settlement | `src/executor/`; `tests/reconciliation.spec.ts`; `evidence/bundle/artifacts/reconciliation-budget.json`; `ARCHITECTURE.md`; `SAFETY.md` | Implementation and saved evidence; not verified against all Razorpay timing behavior. |
| Retry scenario sends once for two requests and remains IN_DOUBT | `scenarios/lab/retry.json`; fresh `lab replay --seed 404` output | Fresh local replay: eight events; one mutation attempt; two requests; charged budget; no confirmed provider effect. |
| Unsafe retry regression reproduces while IntentProof passes | `regressions/lab/unsafe-retry-discovery-one_intent_one_effect.json`; `tests/lab-model-comparison.spec.ts`; `src/lab/regression.ts` | Fresh reproduction and tests passed. Synthetic model, not an observed merchant loss. |
| Saved exploration reduced 15 events to 11 | `evidence/bundle/artifacts/counterfactual-lab.json`; `campaigns/lab/unsafe-retry.json`; saved regression | Saved exploration result. Fresh command reproduces the saved fixture, not a new minimization run. Avoid “exhaustive”. |
| Bundle integrity verifies 11 artifacts | `evidence/bundle/manifest.json`; `src/evidence/proof-bundle.ts` | Fresh verifier: valid true, 11 artifacts. Does not authenticate the author or re-execute every original experiment. |
| One ₹1 Test Mode order succeeded | `evidence/bundle/artifacts/policy-real-test-mode.json`; `evidence/gateway-pass-through.json` | Saved REAL_RAZORPAY_TEST_MODE evidence: 100 paise, one upstream call, succeeded true. No new transaction initiated. |
| Genuine webhook replay is unresolved | `evidence/bundle/artifacts/real-webhook.json`; manifest; live Evidence screen | PENDING_EXTERNAL_REPLAY; additional_transaction_authorized false. Fixture HMAC verification is separate. |
| Public repository address | Local `git remote -v`: `https://github.com/Jayant-kernel/intentproof.git` | Configured repository remote verified; public accessibility not checked in this task. Confirm logged-out access before publishing. |
| Deployed demo address | No verified deployment artifact or URL in the inspected materials | **Unverified.** End card uses the recorded local demo; localhost is not a public deployment. |

## Overlays, captions, and editorial treatment

Use one readable sans-serif face; approximately 32–40px captions at 1080p, two lines maximum. Use neutral panels or modest shadow behind captions. Position them away from verdicts, quotations, per-run counters, and provenance labels. Keep semantic labels textual as well as colored. Retain small but readable provenance slates throughout each relevant shot.

Approved overlay copy:

- “SIMULATED PROPOSAL · DETERMINISTIC FIXTURE”
- “Merchant limit ₹3,000 · Proposed order ₹3,000.01”
- “Approved v1 · C2: order amount ceiling”
- “BLOCK · Gateway calls 1 · Upstream calls 0”
- “ALLOW · ₹199 order · Fake provider calls 1”
- “FAKE PLANNER + FAKE PROVIDER · LOCAL DEMO”
- “Recorded local audit · Hash linkage”
- “SYNTHETIC CHAOS · Retry timeline · Seed 404”
- “SEPARATE SAVED REGRESSION · Seed 2909”
- “Unsafe model FAIL · IntentProof model PASS”
- “Bounded model evidence · Not exhaustive verification”
- “Saved ₹1 Razorpay Test Mode order · Separate evidence”
- “MOCKED_GEMINI · No live-model claim”
- “PENDING_EXTERNAL_REPLAY · Genuine webhook unresolved”
- End card: “IntentProof / github.com/Jayant-kernel/intentproof / Recorded local Control Room demo”.

Use the spoken script as the caption transcript, aligned to the actual delivery. Spell out “paise” correctly; distinguish 300001 from 300000 and ₹3,000.01 from ₹3,001. Avoid captions such as “money saved”, “payment secured”, “hallucination eliminated”, “live Gemini”, “100% safe”, or “webhook verified”.

Do not add number counters, decorative dashboards, fake chat transcripts, reconstructed provider responses, or invented activity. A simple static architecture graphic is enough. At most one short zoom per proof point; return to the full UI to preserve context.

## Recording checklist

- [ ] Confirm v1, C2 amount ceiling, kill switch OFF, and unresolved webhook state before take one.
- [ ] Capture app content only; hide personal tabs, bookmarks, desktop notifications, account names, and unrelated windows.
- [ ] Never display `.env`, credentials, OAuth URLs/codes, raw webhook bodies, real payment identifiers, customer data, or secret-bearing terminal output.
- [ ] Use a quiet room, consistent microphone distance, and a short test recording. Voice must remain intelligible above music; avoid clipping and aggressive noise suppression.
- [ ] Record at 1080p or better. Inspect the exported file at 100% scale for readable rule quotations, call counts, and pending labels.
- [ ] Keep the real pointer visible; move once to each proof point and pause. Avoid circling or repeated clicking.
- [ ] Preserve confirmation dialogs and actual result waits. Never cut a BLOCK result onto an unrelated proposal.
- [ ] Capture blocked and allowed result screens before navigation resets them.
- [ ] Match the expanded audit row to this take's allowed fake execution.
- [ ] Label the retry timeline and separate comparison regression explicitly.
- [ ] Keep budget/executor evidence separate from the basic Control Room fake order run.
- [ ] Retain all simulation, fake-provider, mocked-Gemini, and pending-webhook labels in the two-minute cut.
- [ ] Distinguish 11 artifacts from 10 register entries; avoid presenting the historical 163-test scoreboard as today's complete test run.
- [ ] Check the repository in a logged-out browser before publication. Omit a deployment URL unless independently verified.
- [ ] Preview captions and graphics on a smaller screen; ensure none cover proof.
- [ ] Rehearse both runtimes with a timer, then trim cursor dwell or silent transitions. Do not accelerate evidence footage to fit.
- [ ] Keep the existing webhook listener and zrok process running unchanged. No payment transaction or live-model call is needed.

## Missing footage and evidence before final edit

1. Record a fresh continuous over-limit → permitted-order → matching-audit take. Existing screenshots establish layout, but are not the final narrated take. Preparation did not dispatch any new UI action.
2. Record the Lab retry timeline and the separate regression CLI output, with the labels specified above. The UI has no selectable timeline for the exact minimized regression; the CLI insert bridges that gap without changing code.
3. Create the simple proposal overlay and two-lane architecture graphic in the video editor. They are editorial illustrations, not evidence screens.
4. Record narration and align captions. The time allocations are edit targets, not measured speech recordings.
5. Live Gemini recording is not verified. The supplied script accurately describes the implemented adapter and mocked evidence; no live-model clip is required to record it honestly.
6. Genuine webhook replay remains missing. Keep it pending. Do not generate a new transaction to obtain it for the video.
7. No public deployment was verified. Use the repository and recorded local demo. A local URL is useful for recording preparation, not a remotely accessible call to action.

Only this production document is added for this task. Application code, server processes, `.env`, `TASK.md`, and stored audit/evidence data are left unchanged. No commit or push is performed.
