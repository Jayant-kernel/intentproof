import { VirtualClock } from "./clock.js";
import { SeededRandom } from "./random.js";

interface Scheduled<T> {
  value: T;
  atMs: number;
  tieBreaker: number;
  insertion: number;
}

export class DeterministicScheduler<T extends { at_ms: number }> {
  private readonly queue: Array<Scheduled<T>> = [];
  private insertion = 0;

  constructor(
    private readonly clock: VirtualClock,
    private readonly random: SeededRandom
  ) {}

  schedule(value: T): void {
    if (value.at_ms < this.clock.now()) {
      throw new Error("Cannot schedule an event before the virtual clock");
    }
    this.queue.push({
      value: structuredClone(value),
      atMs: value.at_ms,
      tieBreaker: this.random.nextUint32(),
      insertion: this.insertion++
    });
  }

  drain(): T[] {
    const ordered = this.queue
      .sort(
        (left, right) =>
          left.atMs - right.atMs ||
          left.tieBreaker - right.tieBreaker ||
          left.insertion - right.insertion
      )
      .map((scheduled) => {
        this.clock.advanceTo(scheduled.atMs);
        return structuredClone(scheduled.value);
      });
    this.queue.length = 0;
    return ordered;
  }
}
