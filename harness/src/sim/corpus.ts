/** Fixed, reviewable PR corpus. Nightly runs use a much larger range. */
export const SMOKE_SEEDS: readonly number[] = [
  1,
  2,
  3,
  5,
  8,
  13,
  21,
  34,
  55,
  89,
  144,
  233,
  377,
  610,
  987,
  1597,
  2584,
  4181,
  6765,
  10946,
  0x12345678,
  0x6a09e667,
  0x9e3779b9,
  0xffffffff,
];

export function sequentialSeeds(startSeed: number, count: number): number[] {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new RangeError(`seed count must be a positive safe integer, got ${count}`);
  }
  if (count > 1_000_000) throw new RangeError(`seed count ${count} exceeds the 1000000 safety cap`);
  const start = startSeed >>> 0;
  return Array.from({ length: count }, (_unused, index) => (start + index) >>> 0);
}
