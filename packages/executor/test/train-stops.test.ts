import { describe, expect, it } from "@effect/vitest";
import type { CheckRun } from "@joelhooks/piper/domain";
import { openTrain, readTrain, stepTrain } from "@joelhooks/piper/host";
import { Effect, Layer } from "effect";

import { ExecutorError } from "../src/domain.js";
import { GitHub } from "../src/github.js";
import type { TrainStop } from "../src/train-domain.js";
import {
  admittedIntent,
  notBoarded,
  rerunRefusal,
} from "../src/train-policy.js";
import { TrainStore } from "../src/train-store.js";
import { runTrain } from "../src/train.js";
import { admission, direct, finish, fixture } from "./train-fixture.js";

const refusal = (
  stop: TrainStop | undefined,
  tag: string,
  harm: string,
  next: string
) => {
  expect(stop?._tag).toBe(tag);
  expect(stop?.harm).toBe(harm);
  expect(stop?.next).toBe(next);
};

const completed = (
  conclusion: "failure" | "cancelled" | "success",
  headSha: string
): CheckRun => ({
  conclusion,
  headSha,
  name: "unit",
  runId: 11,
  status: "completed",
});

describe("train refusals", () => {
  it.effect("asks for current base CI when the lone car is behind", () =>
    Effect.gen(function* currentCi() {
      const test = yield* fixture();
      test.github.controls.upToDate = false;

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "NotBoarded",
        "landing a car that did not pass boarding policy",
        "merge the base branch into the car so current CI runs"
      );
      expect(result.stop?.detail).toMatchObject({ path: "lone-board" });
      expect(test.github.writes).toEqual([]);
    })
  );

  it.effect("rechecks the environment-only red before rerunning", () =>
    Effect.gen(function* freshRerun() {
      const test = yield* fixture();
      test.github.controls.trainChecks = [completed("cancelled", "built-a")];
      test.github.controls.rerunGuardRealRed = true;

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "RerunRefused",
        "rerunning a real failure instead of fixing it",
        "fix the red; rerun only a finished environment-only failure"
      );
      expect(
        test.github.writes.filter((operation) =>
          operation.path.endsWith("/rerun-failed-jobs")
        )
      ).toEqual([]);
    })
  );

  it.effect(
    "preserves the claimed write count when recording the outcome fails",
    () =>
      Effect.gen(function* lostOutcome() {
        const test = yield* fixture();
        const memory = yield* TrainStore.pipe(Effect.provide(test.store.layer));

        const broken = Layer.succeed(TrainStore, {
          ...memory,
          append: (line) =>
            line.includes('"done":"BuildTrain"')
              ? Effect.fail(
                  new ExecutorError({
                    code: "storage",
                    message: "synthetic outcome failure",
                  })
                )
              : memory.append(line),
        });

        const result = yield* finish(
          runTrain(admission).pipe(
            Effect.provide(Layer.merge(test.layer, broken))
          )
        );

        refusal(
          result.stop,
          "Unavailable",
          "acting on an incomplete observation or losing the write ledger",
          "hand back; inspect the failure and saved state before restarting"
        );
        expect(result.writes).toBe(1);
        expect((yield* test.store.state)?.writes).toBe(1);
        expect(test.github.writes).toHaveLength(2);
      })
  );
  it.effect(
    "refuses manual resumption after writes before reading providers",
    () =>
      Effect.gen(function* resume() {
        const test = yield* fixture({ seen: [], train: null, writes: 2 });

        const result = yield* finish(
          runTrain(admission).pipe(Effect.provide(test.layer))
        );

        refusal(
          result.stop,
          "ResumeAfterWrites",
          "double writes",
          "hand back; the owner decides"
        );
        expect(result.writes).toBe(2);
        expect(test.github.reads).toEqual([]);
      })
  );

  it.effect("refuses mismatched admission identity", () =>
    Effect.gen(function* identity() {
      const test = yield* fixture();

      const result = yield* finish(
        runTrain({ ...admission, train: 2 }).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "InvalidAdmission",
        "executing a different train from the admission",
        "make input.repo and input.train match the admission"
      );
      expect(test.github.writes).toEqual([]);
    })
  );

  it.effect("refuses a saved train outside the admission", () =>
    Effect.gen(function* savedIdentity() {
      const train = yield* openTrain({ ...admission.input, train: 2 });
      const test = yield* fixture({ seen: [], train, writes: 0 });

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "InvalidAdmission",
        "resuming a different train",
        "use the state directory for this admission"
      );
      expect(test.github.reads).toEqual([]);
    })
  );

  it.effect("ends an inactive train without provider reads", () =>
    Effect.gen(function* inactive() {
      const initial = yield* openTrain(admission.input);

      const train = yield* stepTrain(initial, [
        { at: 0, reason: "synthetic stop", type: "abandon" },
      ]);

      const test = yield* fixture({ seen: [], train, writes: 0 });

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "TrainEnded",
        "continuing a train whose lifecycle ended",
        "inspect the final state and start a new train if needed"
      );
      expect(result.exit).toBe("train ended abandoned");
      expect(test.github.reads).toEqual([]);
    })
  );

  for (const afterBuild of [false, true]) {
    it.effect(
      `refuses a moved car ${afterBuild ? "after building" : "before departure"}`,
      () =>
        Effect.gen(function* movedCar() {
          const test = yield* fixture();
          test.github.controls.moveCarAfterBuild = afterBuild;
          test.github.controls.carHead = afterBuild
            ? admission.car.headSha
            : "other-head";

          const result = yield* finish(
            runTrain(admission).pipe(Effect.provide(test.layer))
          );

          refusal(
            result.stop,
            "CarMoved",
            "landing a head nobody reviewed",
            "name the new head"
          );
          expect(result.exit).toBe("car head moved");
          expect(
            test.github.writes.some((operation) =>
              operation.path.endsWith("/merge")
            )
          ).toBe(false);
        })
    );
  }

  it.effect("refuses a moved base after building", () =>
    Effect.gen(function* movedBase() {
      const test = yield* fixture();
      test.github.controls.moveBaseAfterBuild = true;

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "BaseMoved",
        "merging a combination CI never tested",
        "start a new train on the current base"
      );
      expect(result.exit).toBe("base moved after the build");
      expect(
        test.github.writes.some((operation) =>
          operation.path.endsWith("/merge")
        )
      ).toBe(false);
    })
  );

  const options = {
    absent: [],
    pending: [
      {
        conclusion: null,
        headSha: admission.car.headSha,
        name: "unit",
        status: "in_progress",
      },
    ],
    red: [completed("failure", admission.car.headSha)],
  } satisfies Record<string, readonly CheckRun[]>;

  it.effect("refuses a lone car whose own CI already shows a red", () =>
    Effect.gen(function* knownRed() {
      const test = yield* fixture();
      test.github.controls.candidateChecks = options.red;

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "NotBoarded",
        "landing a car that did not pass boarding policy",
        "fix the red"
      );
      expect(result.exit).toBe("car not boarded");
      expect(test.github.writes).toEqual([]);
    })
  );

  for (const kind of ["absent", "pending"] as const) {
    it.effect(`boards a lone car on push while its check is ${kind}`, () =>
      Effect.gen(function* loneBoard() {
        const test = yield* fixture();
        test.github.controls.candidateChecks = options[kind];

        const result = yield* finish(
          runTrain({
            ...admission,
            input: {
              ...admission.input,
              candidateRequiredChecks: [["unit", "lint"]],
            },
          }).pipe(Effect.provide(test.layer))
        );

        expect(result.exit).toBe("landed");
        expect(test.github.writes[0]?.path).toBe("/git/refs/heads/train%2F1");
      })
    );
  }

  for (const kind of ["absent", "red", "pending"] as const) {
    it.effect(
      `keeps light-done advice for a ${kind} required check in a shared group`,
      () =>
        Effect.gen(function* sharedAdvice() {
          const opened = yield* openTrain(admission.input);

          const candidate = {
            checks: options[kind],
            headSha: admission.car.headSha,
            labels: [admission.input.trainLabel],
            number: admission.car.number,
            operatorReviewed: true,
            owner: "author-a",
            upToDate: true,
          };

          const waiting = yield* readTrain(
            yield* stepTrain(opened, [
              {
                at: 0,
                candidates: [
                  candidate,
                  { ...candidate, headSha: "car-b", number: 2 },
                ],
                main: "base-a",
                type: "candidates",
              },
              { at: 0, type: "depart" },
            ])
          );

          const next = {
            absent: "merge the base branch into the car so current CI runs",
            pending: "board again when it finishes",
            red: "fix the red",
          };

          const stop = notBoarded(waiting.context, admission);

          refusal(
            stop,
            "NotBoarded",
            "landing a car that did not pass boarding policy",
            next[kind]
          );
          expect(stop.detail).toMatchObject({ path: "train" });
        })
    );
  }

  it.effect(
    "gives a shared car under notKnownRed red advice, never base-merge advice",
    () =>
      Effect.gen(function* sharedRed() {
        const input = {
          ...admission.input,
          sharedBoarding: "notKnownRed" as const,
        };

        const candidate = {
          checks: [
            { ...completed("failure", admission.car.headSha), name: "lint" },
          ],
          headSha: admission.car.headSha,
          labels: [admission.input.trainLabel],
          number: admission.car.number,
          operatorReviewed: true,
          owner: "author-a",
          upToDate: true,
        };

        const waiting = yield* readTrain(
          yield* stepTrain(yield* openTrain(input), [
            {
              at: 0,
              candidates: [
                candidate,
                { ...candidate, checks: [], headSha: "car-b", number: 2 },
              ],
              main: "base-a",
              type: "candidates",
            },
            { at: 0, type: "depart" },
          ])
        );

        expect(waiting.context.cars.map((entry) => entry.number)).toEqual([2]);
        refusal(
          notBoarded(waiting.context, { ...admission, input }),
          "NotBoarded",
          "landing a car that did not pass boarding policy",
          "fix the red"
        );
      })
  );

  it.effect("hands back a red train naming its failing checks", () =>
    Effect.gen(function* outside() {
      const test = yield* fixture();
      test.github.controls.trainChecks = [completed("failure", "built-a")];

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "RealRed",
        "landing a car whose train CI failed",
        "fix the red in the car (unit), then board it again"
      );
      expect(result.exit).toBe("real red");
      expect(
        test.github.writes.some((operation) =>
          operation.path.endsWith("/comments")
        )
      ).toBe(false);
    })
  );

  it("requires the exact branch, car count, number and admitted head on builds", () => {
    const template = {
      at: 0,
      base: "base-a",
      branch: "train/1",
      buildId: 1,
      cars: [{ ...admission.car, owner: "author" }],
      id: "train-1/1",
      kind: "BuildTrain",
      purpose: "train",
    } satisfies Parameters<typeof admittedIntent>[1];

    for (const changed of [
      { ...template, branch: "other" },
      { ...template, cars: [] },
      { ...template, cars: [...template.cars, ...template.cars] },
      {
        ...template,
        cars: [{ ...admission.car, number: 2, owner: "author" }],
      },
      {
        ...template,
        cars: [{ ...admission.car, headSha: "other", owner: "author" }],
      },
    ]) {
      const stop = admittedIntent(admission, changed);
      refusal(
        stop,
        "OutsideAdmission",
        "writing outside the reviewed car and train",
        "hand back; admit a new train for the required action"
      );
    }

    expect(admittedIntent(admission, template)).toBeUndefined();
  });

  it("merges the admitted car directly only at its reviewed head", () => {
    const merge = {
      at: 0,
      id: "train-1/1",
      kind: "Merge",
      matchHead: admission.car.headSha,
      pr: admission.car.number,
    } satisfies Parameters<typeof admittedIntent>[1];

    expect(admittedIntent(admission, merge)).toBeUndefined();
    expect(
      admittedIntent(admission, { ...merge, matchHead: "train-head", pr: 3 })
    ).toBeUndefined();
    refusal(
      admittedIntent(admission, { ...merge, matchHead: "unreviewed" }),
      "OutsideAdmission",
      "landing a head nobody reviewed",
      "name the new head"
    );
  });

  it.effect("reruns an environment-only red once and then lands", () =>
    Effect.gen(function* rerun() {
      const test = yield* fixture();
      test.github.controls.trainChecks = [completed("cancelled", "built-a")];

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      expect(result.exit).toBe("landed");
      expect(
        test.github.writes.filter((operation) =>
          operation.path.endsWith("/rerun-failed-jobs")
        )
      ).toHaveLength(1);
      const lines = yield* test.sink.lines;
      expect(
        lines.filter((line) => line.includes('"rerun":true'))
      ).toHaveLength(1);
      expect(lines.find((line) => line.includes('"rerun":true'))).toContain(
        '"faults":[{"conclusion":"cancelled","name":"unit","runId":11}]'
      );
    })
  );

  for (const kind of [
    "real",
    "mixed",
    "absent",
    "pending",
    "ignored",
    "wrong-head",
  ] satisfies readonly (
    | "real"
    | "mixed"
    | "absent"
    | "pending"
    | "ignored"
    | "wrong-head"
  )[]) {
    it(`refuses a ${kind} red as a rerun justification`, () => {
      const red = completed("failure", "built-a");
      const environment = completed("cancelled", "built-a");

      const cases = {
        absent: [],
        ignored: [{ ...environment, name: "ignored" }],
        mixed: [environment, red],
        pending: [{ ...environment, conclusion: null, status: "in_progress" }],
        real: [red],
        "wrong-head": [{ ...environment, headSha: "other" }],
      } satisfies Record<string, readonly CheckRun[]>;

      const stop = rerunRefusal(
        cases[kind],
        {
          ...admission,
          input: { ...admission.input, ignoredChecks: ["ignored"] },
        },
        "built-a"
      );

      refusal(
        stop,
        "RerunRefused",
        "rerunning a real failure instead of fixing it",
        "fix the red; rerun only a finished environment-only failure"
      );
    });
  }

  for (const [path, admitted, pr] of [
    ["train", admission, 3],
    ["direct", direct, admission.car.number],
  ] as const) {
    it.effect(
      `stops a failed ready-mark on the ${path} path with its code and message, before merging a draft`,
      () =>
        Effect.gen(function* readyFailure() {
          const test = yield* fixture();
          test.github.controls.drafts = [admission.car.number];
          test.github.controls.graphqlErrors = true;

          const result = yield* finish(
            runTrain(admitted).pipe(Effect.provide(test.layer))
          );

          refusal(
            result.stop,
            "ReadyFailed",
            "merging a draft pull request, which the provider refuses",
            `mark #${pr} ready for review, then merge it at the tested head or admit a new train`
          );
          expect(result.exit).toBe("MarkReady failed");
          expect(result.stop?.detail).toMatchObject({
            code: "provider",
            message: "GraphQL errors: Resource not accessible by integration",
          });
          expect(result.writes).toBe((yield* test.store.state)?.writes);
          expect(
            test.github.writes.some((operation) =>
              operation.path.endsWith("/merge")
            )
          ).toBe(false);
        })
    );
  }

  it.effect("stops at a provider merge refusal", () =>
    Effect.gen(function* mergeRefused() {
      const test = yield* fixture();
      test.github.controls.mergeRefused = true;

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      refusal(
        result.stop,
        "MergeRefused",
        "merging a head the provider refused",
        "hand back; inspect the refusal and tested head"
      );
      expect(result.exit).toBe("merge refused");
      expect(
        test.github.writes.some((operation) => operation.method === "DELETE")
      ).toBe(false);
    })
  );

  it.effect("stops on a typed observation failure", () =>
    Effect.gen(function* observationFailure() {
      const test = yield* fixture();

      const broken = Layer.succeed(GitHub, {
        read: () =>
          Effect.fail(
            new ExecutorError({
              code: "provider",
              message: "synthetic unavailable",
            })
          ),
      });

      const result = yield* finish(
        runTrain(admission).pipe(
          Effect.provide(Layer.merge(test.layer, broken))
        )
      );

      refusal(
        result.stop,
        "Unavailable",
        "acting on an incomplete observation or losing the write ledger",
        "hand back; inspect the failure and saved state before restarting"
      );
      expect(test.github.writes).toEqual([]);
    })
  );
});
