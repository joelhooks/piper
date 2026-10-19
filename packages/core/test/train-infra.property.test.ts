import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { CheckRun, TrainEvent } from "../src/domain.js";
import type { TrainSnapshot } from "../src/host.js";
import { openTrain, readTrain, stateName, stepTrain } from "../src/host.js";
import {
  ciOn,
  input,
  JUDGE,
  numbers,
  T0,
  TRAIN_1_HEAD,
  TRAIN_1_PR,
  TRAIN_1_SLICES,
} from "./fixtures.js";
import { jsonSnapshot } from "./json-snapshot.js";

const faults = Arbitrary.array(
  Arbitrary.schema(Schema.Literals(["cancelled", "startup_failure", "stale"])),
  { maxLength: 6, minLength: 1 }
);

const infrastructureChecks = (
  head: string,
  conclusions: readonly ("cancelled" | "startup_failure" | "stale")[]
): readonly CheckRun[] => [
  ...ciOn(head),
  ...conclusions.map((conclusion, index): CheckRun => ({
    conclusion,
    headSha: head,
    name: `runner-${index}`,
    status: "completed",
  })),
];

const checksEvent = (
  head: string,
  checks: readonly CheckRun[],
  at = T0 + 4
): Extract<TrainEvent, { readonly type: "checks" }> => ({
  at,
  checks,
  head,
  type: "checks",
});

const testingTrain = Effect.fn("testingTrain")(function* testingTrain() {
  return yield* stepTrain(yield* openTrain(input(1)), [
    {
      at: T0,
      candidates: TRAIN_1_SLICES,
      main: "main-before-train",
      type: "candidates",
    },
    { at: T0 + 1, type: "depart" },
    {
      at: T0 + 2,
      buildId: 1,
      conflicted: [],
      head: TRAIN_1_HEAD,
      merged: numbers(TRAIN_1_SLICES),
      type: "built",
    },
    { at: T0 + 3, pr: TRAIN_1_PR, type: "prOpened" },
  ]);
});

const expectRerun = (snapshot: TrainSnapshot, head: string, at: number) => {
  expect(snapshot.context.reruns).toContain(head);
  expect(
    snapshot.context.intents.filter((intent) => intent.kind === "RerunChecks")
  ).toEqual([expect.objectContaining({ head, kind: "RerunChecks" })]);
  expect(
    snapshot.context.facts.filter((fact) => fact.kind === "rerun")
  ).toEqual([{ at, head, kind: "rerun" }]);
  expect(snapshot.context.checks).toEqual([]);
  expect(snapshot.context.pollAt).toBe(at + input(1).pollMs);
  expect(snapshot.context.ciDeadlineAt).toBe(at + input(1).ciTimeoutMs);
};

const expectNoRanking = (snapshot: TrainSnapshot) => {
  expect(
    snapshot.context.intents.filter((intent) => intent.kind === "RankSuspects")
  ).toEqual([]);
};

const expectTriaging = (snapshot: TrainSnapshot) => {
  expect(stateName(snapshot)).toBe("testing.triaging");
  expect(
    snapshot.context.intents.filter((intent) => intent.kind === "RankSuspects")
  ).toHaveLength(1);
  expect(
    snapshot.context.intents.filter((intent) => intent.kind === "RerunChecks")
  ).toHaveLength(1);
};

describe("train environment faults", () => {
  it.effect.prop(
    "infra-only red reruns once, polls, and green reaches ready and merge",
    { conclusions: faults },
    ({ conclusions }) =>
      Effect.gen(function* greenAfterRerun() {
        const retried = yield* stepTrain(yield* testingTrain(), [
          checksEvent(
            TRAIN_1_HEAD,
            infrastructureChecks(TRAIN_1_HEAD, conclusions)
          ),
        ]);

        const snapshot = yield* readTrain(retried);

        expect(stateName(snapshot)).toBe("testing.polling");
        expectRerun(snapshot, TRAIN_1_HEAD, T0 + 4);
        expectNoRanking(snapshot);
        expect(
          snapshot.context.facts.filter((fact) => fact.kind === "verdict")
        ).toEqual([]);

        const polled = yield* stepTrain(retried, [
          { at: T0 + 4 + input(1).pollMs, type: "tick" },
        ]);

        expect((yield* readTrain(polled)).context.intents).toContainEqual(
          expect.objectContaining({ head: TRAIN_1_HEAD, kind: "PollChecks" })
        );

        const ready = yield* stepTrain(polled, [
          checksEvent(
            TRAIN_1_HEAD,
            ciOn(TRAIN_1_HEAD),
            T0 + 5 + input(1).pollMs
          ),
        ]);

        expect(stateName(yield* readTrain(ready))).toBe("landing.awaitingGo");

        const landed = yield* readTrain(
          yield* stepTrain(ready, [
            {
              at: T0 + 6 + input(1).pollMs,
              by: "operator",
              head: TRAIN_1_HEAD,
              type: "go",
            },
            {
              at: T0 + 7 + input(1).pollMs,
              head: TRAIN_1_HEAD,
              mergeSha: "merged-train",
              type: "merged",
            },
          ])
        );

        expect(stateName(landed)).toBe("landed");
        expectNoRanking(landed);
        expect(landed.context.intents).toContainEqual(
          expect.objectContaining({ kind: "MarkReady", pr: TRAIN_1_PR })
        );
        expect(landed.context.intents).toContainEqual(
          expect.objectContaining({ kind: "Merge", matchHead: TRAIN_1_HEAD })
        );
        expect(
          landed.context.intents.filter(
            (intent) => intent.kind === "RerunChecks"
          )
        ).toHaveLength(1);
      })
  );

  it.effect.prop(
    "infra-only red twice on the same head triages the second red",
    { conclusions: faults },
    ({ conclusions }) =>
      Effect.gen(function* repeatedInfra() {
        const event = checksEvent(
          TRAIN_1_HEAD,
          infrastructureChecks(TRAIN_1_HEAD, conclusions)
        );

        const retried = yield* stepTrain(yield* testingTrain(), [event]);
        expectRerun(yield* readTrain(retried), TRAIN_1_HEAD, T0 + 4);
        expectTriaging(
          yield* readTrain(
            yield* stepTrain(retried, [{ ...event, at: T0 + 5 }])
          )
        );
      })
  );

  it.effect.prop(
    "one infra plus a real failure triages without spending a rerun on that head",
    { conclusions: faults },
    ({ conclusions }) =>
      Effect.gen(function* mixedRed() {
        const retried = yield* stepTrain(yield* testingTrain(), [
          checksEvent(
            TRAIN_1_HEAD,
            infrastructureChecks(TRAIN_1_HEAD, conclusions)
          ),
        ]);

        expectRerun(yield* readTrain(retried), TRAIN_1_HEAD, T0 + 4);

        const rebuilt = yield* stepTrain(retried, [
          { at: T0 + 5, main: "new-main", type: "mainMoved" },
          {
            at: T0 + 6,
            buildId: 2,
            conflicted: [],
            head: "mixed-head",
            merged: numbers(TRAIN_1_SLICES),
            type: "built",
          },
          checksEvent(
            "mixed-head",
            [
              ...infrastructureChecks("mixed-head", conclusions),
              ...ciOn("mixed-head", "red"),
            ],
            T0 + 7
          ),
        ]);

        const snapshot = yield* readTrain(rebuilt);
        expectTriaging(snapshot);
        expect(snapshot.context.reruns).not.toContain("mixed-head");
      })
  );

  it.effect.prop(
    "JSON restore between rerun and next poll preserves the one-rerun bound",
    { conclusions: faults },
    ({ conclusions }) =>
      Effect.gen(function* restoredRerun() {
        const event = checksEvent(
          TRAIN_1_HEAD,
          infrastructureChecks(TRAIN_1_HEAD, conclusions)
        );

        const retried = yield* stepTrain(yield* testingTrain(), [event]);
        expectRerun(yield* readTrain(retried), TRAIN_1_HEAD, T0 + 4);
        const saved = jsonSnapshot(retried);

        const nextEvents: TrainEvent[] = [
          { at: T0 + 4 + input(1).pollMs, type: "tick" },
          { ...event, at: T0 + 5 + input(1).pollMs },
        ];

        const restored = yield* readTrain(yield* stepTrain(saved, nextEvents));

        const uninterrupted = yield* readTrain(
          yield* stepTrain(retried, nextEvents)
        );

        expect(restored).toEqual(uninterrupted);
        expectTriaging(restored);
      })
  );

  it.effect.prop(
    "probe infra-only red reruns once before a green or repeated red narrows suspects",
    { conclusions: faults },
    ({ conclusions }) =>
      Effect.gen(function* probeRerun() {
        const probe = yield* stepTrain(yield* testingTrain(), [
          checksEvent(TRAIN_1_HEAD, ciOn(TRAIN_1_HEAD, "red")),
          {
            at: T0 + 5,
            head: TRAIN_1_HEAD,
            judge: JUDGE,
            ranks: [],
            type: "ranked",
          },
        ]);

        const { build } = (yield* readTrain(probe)).context;
        expect(build?.purpose).toBe("probe");

        const testing = yield* stepTrain(probe, [
          {
            at: T0 + 6,
            buildId: build?.id ?? 0,
            conflicted: [],
            head: "probe-head",
            merged: numbers(build?.cars ?? []),
            type: "built",
          },
        ]);

        const event = checksEvent(
          "probe-head",
          infrastructureChecks("probe-head", conclusions),
          T0 + 7
        );

        const retried = yield* stepTrain(testing, [event]);
        const snapshot = yield* readTrain(retried);
        expect(stateName(snapshot)).toBe("bisecting.testing");
        expectRerun(snapshot, "probe-head", T0 + 7);
        expect(snapshot.context.bisect).toEqual(
          (yield* readTrain(testing)).context.bisect
        );
        expect(
          snapshot.context.facts.filter(
            (fact) => fact.kind === "verdict" && fact.head === "probe-head"
          )
        ).toEqual([]);
        expect(
          snapshot.context.intents.filter(
            (intent) => intent.kind === "RankSuspects"
          )
        ).toHaveLength(1);

        for (const checks of [ciOn("probe-head"), event.checks]) {
          const narrowed = yield* readTrain(
            yield* stepTrain(jsonSnapshot(retried), [
              checksEvent("probe-head", checks, T0 + 8),
            ])
          );

          expect(stateName(narrowed)).toBe("bisecting.building");
          expect(narrowed.context.bisect?.suspects).toEqual(
            checks === event.checks
              ? snapshot.context.bisect?.probe
              : snapshot.context.bisect?.suspects.filter(
                  (pr) => snapshot.context.bisect?.probe.includes(pr) === false
                )
          );
          expect(
            narrowed.context.intents.filter(
              (intent) => intent.kind === "RerunChecks"
            )
          ).toHaveLength(1);
        }
      })
  );
});
