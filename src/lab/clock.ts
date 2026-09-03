export class VirtualClock {
  constructor(private currentMs: number) {
    if (!Number.isSafeInteger(currentMs) || currentMs < 0) {
      throw new Error("Virtual clock must start at a non-negative integer millisecond");
    }
  }

  now(): number {
    return this.currentMs;
  }

  advanceTo(targetMs: number): number {
    if (!Number.isSafeInteger(targetMs) || targetMs < this.currentMs) {
      throw new Error("Virtual clock cannot move backwards");
    }
    this.currentMs = targetMs;
    return this.currentMs;
  }

  advanceBy(deltaMs: number): number {
    if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
      throw new Error("Virtual clock delta must be a non-negative integer");
    }
    return this.advanceTo(this.currentMs + deltaMs);
  }
}
