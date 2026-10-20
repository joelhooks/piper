import type { AxiomSettings, Canary, Counts } from "./domain.js";

export interface Span {
  readonly end: number;
  readonly start: number;
}

export const errorWindows = (readyAt: number, windowMinutes: number) => {
  const length = windowMinutes * 60_000;

  return {
    after: { end: readyAt + length, start: readyAt },
    before: { end: readyAt, start: readyAt - length },
  };
};

const rate = (counts: Counts) =>
  counts.requests === 0 ? 0 : counts.errors / counts.requests;

export const errorsVerdict = (
  axiom: AxiomSettings,
  before: Counts,
  after: Counts
): "pass" | "breach" | "unknown" => {
  if (after.requests < axiom.minRequests) {
    return "unknown";
  }

  const ceiling = Math.max(
    rate(before) * axiom.maxRateRatio,
    1 / axiom.minRequests
  );

  return after.errors > axiom.hardFloorErrors && rate(after) > ceiling
    ? "breach"
    : "pass";
};

export const deploymentVerdict = (
  state: string,
  serving: boolean
): "pass" | "fail" | "unknown" => {
  if (state === "ERROR" || state === "CANCELED") {
    return "fail";
  }

  return state === "READY" && serving ? "pass" : "unknown";
};

export const canaryMismatch = (
  canary: Canary,
  status: number,
  body: string
): string | undefined => {
  if (status !== canary.status) {
    return `expected status ${canary.status}, got ${status}`;
  }

  return body.includes(canary.contains)
    ? undefined
    : `body does not contain ${JSON.stringify(canary.contains)}`;
};
