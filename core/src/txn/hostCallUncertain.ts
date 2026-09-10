/** An effect may still execute; retain transaction ownership until worker exit. */
export class HostCallUncertain extends Error {}
