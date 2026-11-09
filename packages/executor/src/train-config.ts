import type { PiperConfig } from "@joelhooks/piper/config";

import type { TrainAdmission } from "./train-domain.js";

export type TrainLaunch = Pick<
  TrainAdmission,
  "car" | "goBy" | "mode" | "tokenCommand" | "train"
>;

export const trainAdmission = (
  { mergeLine, repo }: PiperConfig,
  { car, goBy, mode, tokenCommand, train }: TrainLaunch
): TrainAdmission => {
  const name = `${repo.owner}/${repo.name}`;

  const admission: TrainAdmission = {
    baseBranch: repo.base,
    car,
    goBy,
    input: {
      candidateIgnoredChecks: mergeLine.checks.ignoredAtBoarding,
      candidateRequiredChecks: mergeLine.checks.train,
      ciTimeoutMs: mergeLine.ciTimeoutMs,
      directRequiredChecks: mergeLine.checks.direct,
      ignoredChecks: mergeLine.checks.ignored,
      maxCars: mergeLine.maxCars,
      pollMs: mergeLine.pollMs,
      repo: name,
      requireUpToDate: mergeLine.requireUpToDate,
      sharedBoarding: mergeLine.sharedBoarding,
      train,
      trainLabel: mergeLine.labels.train,
    },
    mode,
    repo: name,
    tokenCommand,
    train,
  };

  const withChecks =
    mergeLine.directWaitChecks === undefined
      ? admission
      : {
          ...admission,
          input: {
            ...admission.input,
            directWaitChecks: mergeLine.directWaitChecks,
          },
        };

  return mergeLine.directWaitMs === undefined
    ? withChecks
    : {
        ...withChecks,
        input: { ...withChecks.input, directWaitMs: mergeLine.directWaitMs },
      };
};
