/**
 * Small, specified 32-bit PRNG for deterministic simulation.
 *
 * Mulberry32 is deliberately implemented here instead of depending on a
 * package: the integer operations below are the replay format. A seed means
 * the same fault schedule on every OS and every future invocation.
 */
export class SeededPrng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  below(exclusiveUpperBound: number): number {
    if (!Number.isSafeInteger(exclusiveUpperBound) || exclusiveUpperBound <= 0) {
      throw new RangeError(`PRNG bound must be a positive safe integer, got ${exclusiveUpperBound}`);
    }
    return this.nextUint32() % exclusiveUpperBound;
  }
}
