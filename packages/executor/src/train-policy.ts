import type { CheckRun, Intent } from "@joelhooks/piper/domain";
import { isFailed, isInfra, latestRuns } from "@joelhooks/piper/policy";
import type { TrainContext } from "@joelhooks/piper/train";
import { Data } from "effect";
import type { Schema } from "effect";

import type { TrainAdmission, TrainStop } from "./train-domain.js";

export const stops = Data.taggedEnum<TrainStop>();

export const admissionRefusal = (cause: Schema.SchemaError): TrainStop => {
  const unnamedBase = cause.message.includes("baseBranch");

  return stops.InvalidAdmission({
    detail: {
      code: "configuration",
      message: "Admission JSON does not match TrainAdmissionSchema",
    },
    harm: unnamedBase
      ? "building against an unnamed base"
      : "acting on an invalid admission",
    next: unnamedBase
      ? "add baseBranch to the admission"
      : "correct the admission JSON before starting the train",
    stop: "invalid admission",
  });
};

export const unavailable = (cause: unknown): TrainStop =>
  stops.Unavailable({
    detail: cause,
    harm: "acting on an incomplete observation or losing the write ledger",
    next: "hand back; inspect the failure and saved state before restarting",
    stop: "runner unavailable",
  });

export const admittedIntent = (
  admission: TrainAdmission,
  intent: Intent
): TrainStop | undefined => {
  if (intent.kind === "BuildTrain") {
    const [car] = intent.cars;

    if (
      intent.branch === `train/${admission.train}` &&
      intent.cars.length === 1 &&
      car?.number === admission.car.number &&
      car.headSha === admission.car.headSha
    ) {
      return undefined;
    }
  } else if (
    [
      "OpenTrainPr",
      "PollChecks",
      "MarkReady",
      "Merge",
      "RemoveLabels",
      "RerunChecks",
    ].includes(intent.kind)
  ) {
    return undefined;
  }

  return stops.OutsideAdmission({
    detail: intent,
    harm: "writing outside the reviewed car and train",
    next: "hand back; admit a new train for the required action",
    stop: "intent outside admission",
  });
};

export const rerunFaults = (
  checks: readonly CheckRun[],
  admission: TrainAdmission,
  head: string
) =>
  checks.filter(
    (check) =>
      check.headSha === head &&
      !admission.input.ignoredChecks.includes(check.name) &&
      isFailed(check)
  );

export const rerunRefusal = (
  checks: readonly CheckRun[],
  admission: TrainAdmission,
  head: string
): TrainStop | undefined => {
  const faults = rerunFaults(checks, admission, head);

  return faults.length > 0 && faults.every(isInfra)
    ? undefined
    : stops.RerunRefused({
        detail: faults,
        harm: "rerunning a real failure instead of fixing it",
        next: "fix the red; rerun only a finished environment-only failure",
        stop: "rerun without an environment-only red",
      });
};

const boardingNext = (absent: boolean, failed: boolean) => {
  if (absent) {
    return "merge the base branch into the car so current CI runs";
  }

  return failed ? "fix the red" : "board again when it finishes";
};

export const notBoarded = (
  context: TrainContext,
  admission: TrainAdmission
): TrainStop => {
  const candidate = context.pool.find(
    (entry) => entry.number === admission.car.number
  );

  const required = admission.input.candidateRequiredChecks ?? [];

  const checks = latestRuns(candidate?.checks ?? []).filter(
    (check) => check.headSha === admission.car.headSha
  );

  const absent =
    required.length > 0 &&
    required.every((group) =>
      group.some((name) => !checks.some((check) => check.name === name))
    );

  const behind =
    admission.input.requireUpToDate !== false && candidate?.upToDate === false;

  const ignored = new Set([
    ...admission.input.ignoredChecks,
    ...(admission.input.candidateIgnoredChecks ?? []),
  ]);

  const failed = checks.some(
    (check) => !ignored.has(check.name) && isFailed(check)
  );

  return stops.NotBoarded({
    detail: { dropped: context.dropped, rejected: context.rejected },
    harm: "landing a car that did not pass boarding policy",
    next: boardingNext(absent || behind, failed),
    stop: "car not boarded",
  });
};
