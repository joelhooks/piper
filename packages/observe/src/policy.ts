import type { AxiomSettings, Canary, Containment, Counts } from "./domain.js";

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

export const isFailedBuild = (state: string): state is "ERROR" | "CANCELED" =>
  state === "ERROR" || state === "CANCELED";

export const deploymentVerdict = (
  state: string,
  serving: boolean
): "pass" | "build-failed" | "unknown" => {
  if (isFailedBuild(state)) {
    return "build-failed";
  }

  return state === "READY" && serving ? "pass" : "unknown";
};

interface DeploymentPosition {
  readonly created: number;
  readonly id: string;
}

export const isNewerDeployment = (
  release: DeploymentPosition,
  target: DeploymentPosition
): boolean => target.id !== release.id && target.created > release.created;

export const isSuperseded = (
  release: DeploymentPosition,
  target: DeploymentPosition,
  contains: Containment
): boolean => isNewerDeployment(release, target) && contains === "yes";

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
