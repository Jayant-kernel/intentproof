import { describe, expect, it } from "vitest";

import { VirtualClock } from "../src/lab/clock.js";
import { SeededRandom } from "../src/lab/random.js";
import { reduceLabState } from "../src/lab/reducer.js";
import type { LabEvent } from "../src/lab/schema.js";
import { DeterministicScheduler } from "../src/lab/scheduler.js";
import { initialLabState } from "../src/lab/state.js";

describe("Counterfactual Lab deterministic primitives", () => {
  it("uses a monotonic virtual clock", () => {
    const clock = new VirtualClock(100);
    expect(clock.advanceBy(25)).toBe(125);
    expect(clock.advanceTo(200)).toBe(200);
    expect(() => clock.advanceTo(199)).toThrow("backwards");
  });

  it("produces the same random sequence from the same seed", () => {
    const first = new SeededRandom(1234);
    const second = new SeededRandom(1234);
    expect(Array.from({ length: 20 }, () => first.nextUint32())).toEqual(
      Array.from({ length: 20 }, () => second.nextUint32())
    );
  });

  it("orders equal-time events reproducibly from the seed", () => {
    const schedule = (seed: number) => {
      const scheduler = new DeterministicScheduler<{ at_ms: number; event_id: string }>(
        new VirtualClock(0),
        new SeededRandom(seed)
      );
      for (const event_id of ["a", "b", "c", "d"]) {
        scheduler.schedule({ at_ms: 10, event_id });
      }
      return scheduler.drain().map((event) => event.event_id);
    };

    expect(schedule(88)).toEqual(schedule(88));
    expect(schedule(88)).not.toEqual(schedule(89));
  });

  it("reduces without mutating its input state", () => {
    const initial = initialLabState(0);
    const untouched = structuredClone(initial);
    const event: LabEvent = {
      schema_version: 1,
      event_id: "request",
      at_ms: 0,
      type: "AGENT_TOOL_REQUESTED",
      intent_id: "intent",
      idempotency_key: "idem",
      tool: "create_order",
      amount_paise: 100,
      currency: "INR"
    };

    const first = reduceLabState(initial, event);
    const second = reduceLabState(initial, event);
    expect(initial).toEqual(untouched);
    expect(first).toEqual(second);
    expect(first).not.toBe(initial);
  });
});
