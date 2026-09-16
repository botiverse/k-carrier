export type SimulationErrorKind = "crash" | "effect-failure" | "invariant";

/** One typed failure family keeps the runner's recovery policy explicit. */
export class SimulationError extends Error {
  readonly kind: SimulationErrorKind;
  readonly effectName: string;

  constructor(kind: SimulationErrorKind, effectName: string, message: string) {
    super(message);
    this.name = "SimulationError";
    this.kind = kind;
    this.effectName = effectName;
  }
}
