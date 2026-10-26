import type { CheckRun, Intent } from "@joelhooks/piper/domain";
import { isFailed, isInfra, isLone, latestRuns } from "@joelhooks/piper/policy";
import { schemaIssuePaths } from "@joelhooks/piper/schema-paths";
import type { TrainContext } from "@joelhooks/piper/train";
import { Data } from "effect";
import type { Schema } from "effect";

import type { ExecutorError } from "./domain.js";
import type { TrainAdmission, TrainStop } from "./train-domain.js";

export const stops = Data.taggedEnum<TrainStop>();

export const admissionRefusal = (cause: Schema.SchemaError): TrainStop => {
  const paths = schemaIssuePaths(cause);

  const unnamedBase = paths.includes("baseBranch");

  const named = paths
    .map((path) => (path === "" ? "the admission root" : path))
    .join(", ");

  return stops.InvalidAdmission({
    detail: {
      code: "configuration",
      message: `Admission JSON does not match TrainAdmissionSchema at ${named}`,
    },
    harm: unnamedBase
      ? "building against an unnamed base"
      : "acting on an invalid admission",
    next: unnamedBase
      ? "add baseBranch to the admission"
      : `fix ${named} in the admission JSON`,
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

export const endsRehearsal = (
  mode: TrainAdmission["mode"] | undefined,
  kind: Intent["kind"] | undefined
): boolean => mode === "dry-run" && (kind === "BuildTrain" || kind === "Merge");

export const admittedIntent = (
  admission: TrainAdmission,
  intent: Intent
): TrainStop | undefined => {
  if (
    intent.kind === "Merge" &&
    intent.pr === admission.car.number &&
    intent.matchHead !== admission.car.headSha
  ) {
    return stops.OutsideAdmission({
      detail: intent,
      harm: "landing a head nobody reviewed",
      next: "name the new head",
      stop: "intent outside admission",
    });
  }

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

  if (intent.kind === "NotifyOwner" && intent.reason === "conflict") {
    return stops.Conflict({
      detail: intent,
      harm: "landing a car that doesn't merge onto main",
      next: "merge main into the car, then GO it again",
      stop: "conflict with main",
    });
  }

  if (intent.kind === "RankSuspects") {
    const failing = [...new Set(intent.failing.map((check) => check.name))]
      .toSorted()
      .join(", ");

    return stops.RealRed({
      detail: intent,
      harm: "landing a car whose train CI failed",
      next: `fix the red in the car (${failing}), then board it again`,
      stop: "real red",
    });
  }

  return stops.OutsideAdmission({
    detail: intent,
    harm: "writing outside the reviewed car and train",
    next: "hand back; admit a new train for the required action",
    stop: "intent outside admission",
  });
};

export const failedStop = (
  intent: Intent,
  error: ExecutorError | undefined
): TrainStop =>
  intent.kind === "MarkReady"
    ? stops.ReadyFailed({
        detail: error,
        harm: "merging a draft pull request, which the provider refuses",
        next: `mark #${intent.pr} ready for review, then merge it at the tested head or admit a new train`,
        stop: "MarkReady failed",
      })
    : stops.ExecutionFailed({
        detail: error,
        harm: "continuing after an unsuccessful or ambiguous operation",
        next: "hand back; inspect the code and message before deciding on writes",
        stop: `${intent.kind} failed`,
      });

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
  const alone = isLone(context.pool);

  const checks = latestRuns(candidate?.checks ?? []).filter(
    (check) => check.headSha === admission.car.headSha
  );

  const absent =
    !alone &&
    admission.input.sharedBoarding !== "notKnownRed" &&
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
    detail: {
      dropped: context.dropped,
      path: alone ? "lone-board" : "train",
      rejected: context.rejected,
    },
    harm: "landing a car that did not pass boarding policy",
    next: boardingNext(absent || behind, failed),
    stop: "car not boarded",
  });
};
