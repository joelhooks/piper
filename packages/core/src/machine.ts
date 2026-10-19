import { setupEffect } from "@xstate/effect";
import { Predicate, Schema } from "effect";
import { types } from "xstate";
import type { StateValue } from "xstate";

import type {
  TrainEvent,
  Candidate,
  Car,
  CheckRun,
  Fact,
  Intent,
  IntentDraft,
  Purpose,
  Rank,
  TrainInput,
} from "./domain.js";
import { TrainEvents, TrainInputSchema } from "./domain.js";
import type { Plan } from "./plan.js";
import {
  excerptOf,
  MAX_CARS,
  probeHalf,
  RERUN_BELOW_P,
  selectCars,
  suspectOrder,
  verdictOn,
} from "./policy.js";

export interface Build {
  readonly id: number;
  readonly base: string;
  readonly cars: readonly Car[];
  readonly purpose: Purpose;
}

export interface Red {
  readonly head: string;
  readonly kind: "failure" | "timeout";
  readonly failing: readonly CheckRun[];
}

export interface Bisect {
  readonly suspects: readonly number[];

  readonly probe: readonly number[];

  readonly red: Red;
}

export interface Drop {
  readonly car: Car;
  readonly reason: "conflict" | "culprit";
  readonly at: number;
}

export interface Rejection {
  readonly type: string;
  readonly at: number | undefined;
  readonly state: string;
}

export interface TrainContext {
  readonly repo: string;
  readonly trainLabel: string;
  readonly ignoredChecks: readonly string[];
  readonly candidateIgnoredChecks?: readonly string[];
  readonly train: number;
  readonly maxCars: number;
  readonly pollMs: number;
  readonly ciTimeoutMs: number;

  readonly main: string | undefined;
  readonly pool: readonly Candidate[];
  readonly plan: Plan | undefined;
  readonly landed: readonly string[];
  readonly cars: readonly Car[];
  readonly dropped: readonly Drop[];
  readonly build: Build | undefined;

  readonly head: string | undefined;
  readonly pr: number | undefined;

  readonly checks: readonly CheckRun[];
  readonly red: Red | undefined;
  readonly ranks: readonly Rank[];

  readonly reruns: readonly string[];
  readonly bisect: Bisect | undefined;
  readonly go:
    | { readonly head: string; readonly by: string; readonly at: number }
    | undefined;
  readonly merged:
    | { readonly head: string; readonly mergeSha: string; readonly at: number }
    | undefined;

  readonly pollAt: number | undefined;
  readonly ciDeadlineAt: number | undefined;
  readonly intents: readonly Intent[];
  readonly facts: readonly Fact[];
  readonly rejected: readonly Rejection[];
  readonly abandonedBecause: string | undefined;

  readonly sync: number;
}

type TrainTransition =
  | {
      readonly context: TrainContext;
      readonly target?:
        | "building"
        | "polling"
        | "testing"
        | "merging"
        | "#train.building"
        | "#train.bisecting.building"
        | "#train.landing"
        | "#train.testing.polling"
        | "#train.landed"
        | "#train.testing.triaging"
        | "#train.abandoned";
    }
  | undefined;

const REJECTIONS_KEPT = 50;

const branchOf = (context: TrainContext) => `train/${context.train}`;

const emit = (
  context: TrainContext,
  at: number,
  ...drafts: readonly IntentDraft[]
): TrainContext => ({
  ...context,
  intents: [
    ...context.intents,
    ...drafts.map((draft, index) => ({
      ...draft,
      at,
      id: `train-${context.train}/${context.intents.length + index + 1}`,
    })),
  ],
});

const record = (context: TrainContext, ...facts: readonly Fact[]) => ({
  ...context,
  facts: [...context.facts, ...facts],
});

const startBuild = (
  context: TrainContext,
  at: number,
  base: string,
  cars: readonly Car[],
  purpose: Purpose
): TrainContext => {
  const build = { base, cars, id: (context.build?.id ?? 0) + 1, purpose };

  return emit(
    {
      ...context,
      build,
      checks: [],
      ciDeadlineAt: undefined,
      go: undefined,
      head: undefined,
      pollAt: undefined,
      red: undefined,
    },
    at,
    {
      base,
      branch: branchOf(context),
      buildId: build.id,
      cars,
      kind: "BuildTrain",
      purpose,
    }
  );
};

const startTesting = (context: TrainContext, at: number): TrainContext => ({
  ...context,
  checks: [],
  ciDeadlineAt: at + context.ciTimeoutMs,
  pollAt: at + context.pollMs,
});

const stopClock = (context: TrainContext): TrainContext => ({
  ...context,
  ciDeadlineAt: undefined,
  pollAt: undefined,
});

const rebuildTrain = (
  context: TrainContext,
  at: number,
  main: string,
  cause: "main-moved" | "merge-refused"
) => ({
  context: startBuild(
    record(
      { ...context, bisect: undefined, main, ranks: [] },
      {
        at,
        base: main,
        cause,
        kind: "rebuild",
      }
    ),
    at,
    main,
    context.cars,
    "train"
  ),
  target: "#train.building" as const,
});

const abandon = (context: TrainContext, at: number, reason: string) => ({
  context: record(
    stopClock(
      context.pr === undefined
        ? { ...context, abandonedBecause: reason }
        : emit({ ...context, abandonedBecause: reason }, at, {
            kind: "CloseTrainPr",
            pr: context.pr,
            reason,
          })
    ),
    { at, kind: "abandoned", reason }
  ),
  target: "#train.abandoned" as const,
});

const dropCars = (
  context: TrainContext,
  at: number,
  numbers: readonly number[],
  reason: "conflict" | "culprit",
  excerpt: string
): TrainContext => {
  const leaving = context.cars.filter((car) => numbers.includes(car.number));

  return record(
    emit(
      {
        ...context,
        cars: context.cars.filter((car) => !numbers.includes(car.number)),
        dropped: [
          ...context.dropped,
          ...leaving.map((car) => ({ at, car, reason })),
        ],
      },
      at,
      ...leaving.map((car): IntentDraft => ({
        car,
        excerpt,
        kind: "NotifyOwner",
        reason,
      }))
    ),
    ...leaving.map((car): Fact => ({
      at,
      kind: "dropped",
      pr: car.number,
      reason,
    }))
  );
};

const continueWithout = (
  context: TrainContext,
  at: number,
  cause: "bisected" | "conflict"
) => {
  if (context.cars.length === 0) {
    return abandon(context, at, `every car left the train (${cause})`);
  }

  const base = context.main ?? context.build?.base ?? "";

  return {
    context: startBuild(
      record(
        { ...context, bisect: undefined, ranks: [], reruns: [] },
        {
          at,
          base,
          cause,
          kind: "rebuild",
        }
      ),
      at,
      base,
      context.cars,
      "train"
    ),
    target: "#train.building" as const,
  };
};

const narrow = (
  context: TrainContext,
  at: number,
  suspects: readonly number[],
  red: Red
) => {
  const [culprit] = suspects;

  if (suspects.length === 1 && culprit !== undefined) {
    return continueWithout(
      dropCars(
        stopClock({ ...context, bisect: undefined }),
        at,
        [culprit],
        "culprit",
        excerptOf(red.failing)
      ),
      at,
      "bisected"
    );
  }

  const probe = probeHalf(suspects);

  return {
    context: startBuild(
      { ...context, bisect: { probe, red, suspects } },
      at,
      context.main ?? context.build?.base ?? "",
      context.cars.filter((car) => probe.includes(car.number)),
      "probe"
    ),
    target: "#train.bisecting.building" as const,
  };
};

const verdictFact = (
  context: TrainContext,
  at: number,
  head: string,
  outcome: "green" | "red" | "timeout"
): TrainContext =>
  record(context, {
    at,
    head,
    kind: "verdict",
    outcome,
    purpose: context.build?.purpose ?? "train",
  });

const probeOutcome = (red: Red | undefined) => {
  if (red === undefined) {
    return "green";
  }

  return red.kind === "timeout" ? "timeout" : "red";
};

const judgeProbe = (
  context: TrainContext,
  at: number,
  red: Red | undefined
): ReturnType<typeof narrow> | undefined => {
  const { bisect } = context;

  if (bisect === undefined) {
    return undefined;
  }

  return red === undefined
    ? narrow(
        context,
        at,
        bisect.suspects.filter((pr) => !bisect.probe.includes(pr)),
        bisect.red
      )
    : narrow(context, at, bisect.probe, red);
};

const triage = (context: TrainContext, at: number, red: Red) => ({
  context: emit(
    verdictFact(
      stopClock({ ...context, red }),
      at,
      red.head,
      red.kind === "timeout" ? "timeout" : "red"
    ),
    at,
    {
      cars: context.cars,
      failing: red.failing,
      head: red.head,
      kind: "RankSuspects",
    }
  ),
  target: "#train.testing.triaging" as const,
});

const rejectedState = (value: StateValue): string =>
  Predicate.isString(value) ? value : JSON.stringify(value);

const timeOf = (
  event: TrainEvent | { readonly type: "sync"; readonly token: number }
): number | undefined => ("at" in event ? event.at : undefined);

export const trainMachine = setupEffect({
  schemas: {
    context: types<TrainContext>(),
    events: { ...TrainEvents, sync: Schema.Struct({ token: Schema.Int }) },
    input: TrainInputSchema,
  },
}).createMachine({
  context: ({ input }: { input: TrainInput }) => ({
    abandonedBecause: undefined,
    bisect: undefined,
    build: undefined,
    candidateIgnoredChecks: input.candidateIgnoredChecks ?? [],
    cars: [],
    checks: [],
    ciDeadlineAt: undefined,
    ciTimeoutMs: input.ciTimeoutMs,
    dropped: [],
    facts: [],
    go: undefined,
    head: undefined,
    ignoredChecks: input.ignoredChecks,
    intents: [],
    landed: [],
    main: undefined,
    maxCars: Math.min(input.maxCars, MAX_CARS),
    merged: undefined,
    plan: undefined,
    pollAt: undefined,
    pollMs: input.pollMs,
    pool: [],
    pr: undefined,
    ranks: [],
    red: undefined,
    rejected: [],
    repo: input.repo,
    reruns: [],
    sync: 0,
    train: input.train,
    trainLabel: input.trainLabel,
  }),
  id: "train",
  initial: "collecting",
  on: {
    "*": ({ context, event, value }) => ({
      context: {
        ...context,
        rejected: [
          ...context.rejected,
          { at: timeOf(event), state: rejectedState(value), type: event.type },
        ].slice(-REJECTIONS_KEPT),
      },
    }),
    abandon: ({ context, event }) => abandon(context, event.at, event.reason),
    plan: ({ context, event }) => ({
      context: { ...context, landed: event.landed, plan: event.plan },
    }),
    prOpened: ({ context, event }) => ({
      context: { ...context, pr: event.pr },
    }),
    sync: ({ context, event }) => ({
      context: { ...context, sync: event.token },
    }),
    tick: {},
  },
  output: ({ context }) => ({
    abandonedBecause: context.abandonedBecause,
    cars: context.cars.map((car) => car.number),
    merged: context.merged,
    train: context.train,
  }),
  states: {
    abandoned: { type: "final" },
    bisecting: {
      initial: "building",
      on: {
        mainMoved: ({ context, event }): TrainTransition => {
          if (event.main === context.main || context.bisect === undefined) {
            return undefined;
          }

          const { probe } = context.bisect;

          return {
            context: startBuild(
              record(
                { ...context, main: event.main },
                {
                  at: event.at,
                  base: event.main,
                  cause: "main-moved",
                  kind: "rebuild",
                }
              ),
              event.at,
              event.main,
              context.cars.filter((car) => probe.includes(car.number)),
              "probe"
            ),
            target: "#train.bisecting.building",
          };
        },
      },
      states: {
        building: {
          on: {
            buildFailed: ({ context, event }) =>
              context.build?.id === event.buildId
                ? abandon(
                    context,
                    event.at,
                    `probe build failed: ${event.reason}`
                  )
                : undefined,
            built: ({ context, event }): TrainTransition => {
              const { build } = context;

              if (build?.id !== event.buildId || build.purpose !== "probe") {
                return undefined;
              }

              const conflicted = build.cars
                .map((car) => car.number)
                .filter(
                  (pr) =>
                    event.conflicted.includes(pr) || !event.merged.includes(pr)
                );

              if (conflicted.length > 0) {
                return continueWithout(
                  dropCars(
                    stopClock({ ...context, bisect: undefined }),
                    event.at,
                    conflicted,
                    "conflict",
                    `#${conflicted.join(", #")} did not merge cleanly onto ${build.base}.`
                  ),
                  event.at,
                  "conflict"
                );
              }

              return {
                context: startTesting(
                  record(
                    { ...context, head: event.head },
                    {
                      at: event.at,
                      base: build.base,
                      buildId: build.id,
                      cars: build.cars.map((car) => car.number),
                      head: event.head,
                      kind: "built",
                      purpose: "probe",
                    }
                  ),
                  event.at
                ),
                target: "testing",
              };
            },
          },
        },
        testing: {
          on: {
            checks: ({ context, event }): TrainTransition => {
              if (event.head !== context.head) {
                return undefined;
              }

              const verdict = verdictOn(
                event.head,
                event.checks,
                context.ignoredChecks
              );

              const next = { ...context, checks: event.checks };

              if (Predicate.isTagged(verdict, "Pending")) {
                return { context: next };
              }

              const red = Predicate.isTagged(verdict, "Red")
                ? {
                    failing: verdict.failing,
                    head: event.head,
                    kind: verdict.kind,
                  }
                : undefined;

              return judgeProbe(
                verdictFact(
                  stopClock(next),
                  event.at,
                  event.head,
                  probeOutcome(red)
                ),
                event.at,
                red
              );
            },
            tick: ({ context, event }): TrainTransition => {
              if (context.head === undefined) {
                return undefined;
              }

              if (
                context.ciDeadlineAt !== undefined &&
                event.at >= context.ciDeadlineAt
              ) {
                return judgeProbe(
                  verdictFact(
                    stopClock(context),
                    event.at,
                    context.head,
                    "timeout"
                  ),
                  event.at,
                  { failing: [], head: context.head, kind: "timeout" }
                );
              }

              if (context.pollAt !== undefined && event.at >= context.pollAt) {
                return {
                  context: emit(
                    { ...context, pollAt: event.at + context.pollMs },
                    event.at,
                    { head: context.head, kind: "PollChecks" }
                  ),
                };
              }

              return undefined;
            },
          },
        },
      },
    },
    building: {
      on: {
        buildFailed: ({ context, event }) =>
          context.build?.id === event.buildId
            ? abandon(context, event.at, `build failed: ${event.reason}`)
            : undefined,
        built: ({ context, event }): TrainTransition => {
          const { build } = context;

          if (build?.id !== event.buildId || build.purpose !== "train") {
            return undefined;
          }

          const conflicted = build.cars
            .map((car) => car.number)
            .filter(
              (pr) =>
                event.conflicted.includes(pr) || !event.merged.includes(pr)
            );

          const built = record(
            dropCars(
              { ...context, cars: build.cars },
              event.at,
              conflicted,
              "conflict",
              `#${conflicted.join(", #")} did not merge cleanly onto ${build.base}.`
            ),
            {
              at: event.at,
              base: build.base,
              buildId: build.id,
              cars: build.cars
                .map((car) => car.number)
                .filter((pr) => !conflicted.includes(pr)),
              head: event.head,
              kind: "built",
              purpose: "train",
            }
          );

          if (built.cars.length === 0) {
            return abandon(built, event.at, "every car conflicted with main");
          }

          const opened =
            built.pr === undefined
              ? emit(built, event.at, {
                  base: build.base,
                  branch: branchOf(built),
                  cars: built.cars,
                  kind: "OpenTrainPr",
                })
              : built;

          return {
            context: startTesting({ ...opened, head: event.head }, event.at),
            target: "testing",
          };
        },
        mainMoved: ({ context, event }) =>
          event.main === context.main
            ? undefined
            : rebuildTrain(context, event.at, event.main, "main-moved"),
      },
    },
    collecting: {
      on: {
        candidates: ({ context, event }) => ({
          context: { ...context, main: event.main, pool: event.candidates },
        }),
        depart: ({ context, event }): TrainTransition => {
          const cars = selectCars(
            context.pool,
            context.maxCars,
            context,
            context.plan,
            new Set(context.landed)
          );

          if (context.main === undefined || cars.length === 0) {
            return undefined;
          }

          return {
            context: startBuild(
              { ...context, cars },
              event.at,
              context.main,
              cars,
              "train"
            ),
            target: "building",
          };
        },
        mainMoved: ({ context, event }) => ({
          context: { ...context, main: event.main },
        }),
      },
    },
    landed: { type: "final" },
    landing: {
      initial: "awaitingGo",
      states: {
        awaitingGo: {
          on: {
            checks: ({ context, event }): TrainTransition => {
              if (event.head !== context.head) {
                return undefined;
              }

              const verdict = verdictOn(
                event.head,
                event.checks,
                context.ignoredChecks
              );

              const next = { ...context, checks: event.checks };

              if (Predicate.isTagged(verdict, "Green")) {
                return { context: next };
              }

              return Predicate.isTagged(verdict, "Red")
                ? triage(next, event.at, {
                    failing: verdict.failing,
                    head: event.head,
                    kind: verdict.kind,
                  })
                : {
                    context: startTesting(next, event.at),
                    target: "#train.testing.polling",
                  };
            },
            go: ({ context, event }): TrainTransition => {
              if (
                event.head !== context.head ||
                context.pr === undefined ||
                context.build?.purpose !== "train" ||
                !Predicate.isTagged(
                  verdictOn(event.head, context.checks, context.ignoredChecks),
                  "Green"
                )
              ) {
                return undefined;
              }

              return {
                context: record(
                  emit(
                    {
                      ...context,
                      go: { at: event.at, by: event.by, head: event.head },
                    },
                    event.at,
                    { kind: "MarkReady", pr: context.pr },
                    { kind: "Merge", matchHead: event.head, pr: context.pr }
                  ),
                  { at: event.at, by: event.by, head: event.head, kind: "go" }
                ),
                target: "merging",
              };
            },
            mainMoved: ({ context, event }) =>
              event.main === context.main
                ? undefined
                : rebuildTrain(context, event.at, event.main, "main-moved"),
          },
        },
        merging: {
          on: {
            checks: ({ context, event }) =>
              event.head === context.head
                ? { context: { ...context, checks: event.checks } }
                : undefined,
            mainMoved: ({ context, event }) => ({
              context: { ...context, main: event.main },
            }),
            mergeRefused: ({ context, event }) =>
              event.head === context.head
                ? rebuildTrain(
                    context,
                    event.at,
                    context.main ?? context.build?.base ?? "",
                    "merge-refused"
                  )
                : undefined,
            merged: ({ context, event }): TrainTransition => {
              if (
                event.head !== context.head ||
                context.go?.head !== event.head
              ) {
                return undefined;
              }

              return {
                context: record(
                  emit(
                    {
                      ...context,
                      merged: {
                        at: event.at,
                        head: event.head,
                        mergeSha: event.mergeSha,
                      },
                    },
                    event.at,
                    {
                      kind: "RemoveLabels",
                      label: context.trainLabel,
                      prs: [
                        ...context.cars.map((car) => car.number),
                        ...(context.pr === undefined ? [] : [context.pr]),
                      ],
                    }
                  ),
                  {
                    at: event.at,
                    cars: context.cars.map((car) => car.number),
                    head: event.head,
                    kind: "merged",
                    mergeSha: event.mergeSha,
                  }
                ),
                target: "#train.landed",
              };
            },
          },
        },
      },
    },
    testing: {
      initial: "polling",
      on: {
        mainMoved: ({ context, event }) =>
          event.main === context.main
            ? undefined
            : rebuildTrain(context, event.at, event.main, "main-moved"),
      },
      states: {
        polling: {
          on: {
            checks: ({ context, event }): TrainTransition => {
              if (event.head !== context.head) {
                return undefined;
              }

              const verdict = verdictOn(
                event.head,
                event.checks,
                context.ignoredChecks
              );

              const next = { ...context, checks: event.checks };

              if (Predicate.isTagged(verdict, "Pending")) {
                return { context: next };
              }

              if (Predicate.isTagged(verdict, "Red")) {
                return triage(next, event.at, {
                  failing: verdict.failing,
                  head: event.head,
                  kind: verdict.kind,
                });
              }

              return {
                context: verdictFact(
                  stopClock(next),
                  event.at,
                  event.head,
                  "green"
                ),
                target: "#train.landing",
              };
            },
            tick: ({ context, event }): TrainTransition => {
              if (context.head === undefined) {
                return undefined;
              }

              if (
                context.ciDeadlineAt !== undefined &&
                event.at >= context.ciDeadlineAt
              ) {
                return triage(context, event.at, {
                  failing: [],
                  head: context.head,
                  kind: "timeout",
                });
              }

              if (context.pollAt !== undefined && event.at >= context.pollAt) {
                return {
                  context: emit(
                    { ...context, pollAt: event.at + context.pollMs },
                    event.at,
                    { head: context.head, kind: "PollChecks" }
                  ),
                };
              }

              return undefined;
            },
          },
        },
        triaging: {
          on: {
            rankFailed: ({ context, event }): TrainTransition => {
              const { red } = context;

              if (red === undefined || event.head !== red.head) {
                return undefined;
              }

              return narrow(
                record(
                  { ...context, ranks: [] },
                  {
                    at: event.at,
                    failed: event.reason,
                    head: event.head,
                    judge: undefined,
                    kind: "judged",
                    ranks: [],
                  }
                ),
                event.at,
                suspectOrder(context.cars, []),
                red
              );
            },
            ranked: ({ context, event }): TrainTransition => {
              const { red } = context;

              if (red === undefined || event.head !== red.head) {
                return undefined;
              }

              const judged = record(context, {
                at: event.at,
                failed: undefined,
                head: event.head,
                judge: event.judge,
                kind: "judged",
                ranks: event.ranks.map((rank) => ({
                  evidence: rank.evidence?.length ?? 0,
                  p: rank.p,
                  pr: rank.pr,
                })),
              });

              const calm = context.cars.every((car) =>
                event.ranks.some(
                  (rank) =>
                    rank.pr === car.number &&
                    rank.p !== "unknown" &&
                    rank.p < RERUN_BELOW_P
                )
              );

              if (
                red.kind === "timeout" &&
                calm &&
                !context.reruns.includes(red.head)
              ) {
                return {
                  context: record(
                    emit(
                      startTesting(
                        {
                          ...judged,
                          ranks: event.ranks,
                          red: undefined,
                          reruns: [...context.reruns, red.head],
                        },
                        event.at
                      ),
                      event.at,
                      { head: red.head, kind: "RerunChecks" }
                    ),
                    { at: event.at, head: red.head, kind: "rerun" }
                  ),
                  target: "polling",
                };
              }

              return narrow(
                { ...judged, ranks: event.ranks },
                event.at,
                suspectOrder(context.cars, event.ranks),
                red
              );
            },
          },
        },
      },
    },
  },
});

export type TrainMachine = typeof trainMachine;
