import { describe, expect, it } from "@effect/vitest";
import type { CheckRun } from "@joelhooks/piper/domain";
import { ConfigProvider, Effect, Layer, Predicate, Schema } from "effect";

import { ExecutorError } from "../src/domain.js";
import { Recorder } from "../src/recorder.js";
import type { TrainRecordValue, TrainStop } from "../src/train-domain.js";
import { TrainRecord } from "../src/train-domain.js";
import { decodeTrainAdmission, runTrain } from "../src/train.js";
import { GitHubWrites } from "../src/writes.js";
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

const carCheck = (
  name: string,
  status: "completed" | "in_progress",
  conclusion: "success" | null
): CheckRun => ({
  conclusion,
  headSha: admission.car.headSha,
  name,
  status,
});

const recordsOf = Effect.fn("TrainTest.records")(function* recordsOf(
  lines: readonly string[]
) {
  return yield* Effect.all(
    lines.map((line) =>
      Schema.decodeEffect(Schema.fromJsonString(TrainRecord))(line)
    )
  );
});

const doneKinds = (records: readonly TrainRecordValue[]) =>
  records.flatMap((record) => ("done" in record ? [record.done] : []));

const pathsOf = (records: readonly TrainRecordValue[]) =>
  records.flatMap((record) => ("path" in record ? [record] : []));

describe("admitted train runner", () => {
  it.effect(
    "a failed dry build stops instead of reaching the rehearsal final state",
    () =>
      Effect.gen(function* failedRehearsal() {
        const test = yield* fixture();

        const failingRecorder = Layer.succeed(Recorder, {
          append: () =>
            Effect.fail(
              new ExecutorError({
                code: "storage",
                message: "synthetic recorder failure",
              })
            ),
        });

        const result = yield* runTrain({ ...admission, mode: "dry-run" }).pipe(
          Effect.provide(Layer.merge(test.layer, failingRecorder))
        );

        expect(result.success).toBe(false);
        expect(result.exit).toBe("BuildTrain failed");
        expect(result.stop?.harm).toBe(
          "continuing after an unsuccessful or ambiguous operation"
        );
        expect(test.github.writes).toEqual([]);
      })
  );
  it.effect(
    "can rehearse a saved read-only build again without hanging or writing",
    () =>
      Effect.gen(function* resumedRehearsal() {
        const test = yield* fixture();

        const dry = { ...admission, mode: "dry-run" } satisfies Parameters<
          typeof runTrain
        >[0];

        const first = yield* runTrain(dry).pipe(Effect.provide(test.layer));
        expect(first.exit).toBe("rehearsal complete");

        const second = yield* finish(
          runTrain(dry).pipe(Effect.provide(test.layer))
        );

        expect(second.exit).toBe("rehearsal complete");
        expect(second.writes).toBe(0);
        expect(test.github.writes).toEqual([]);
        expect(test.github.records).toHaveLength(2);
      })
  );
  it.effect(
    "lands one admitted car and preserves the record line contract",
    () =>
      Effect.gen(function* landed() {
        const test = yield* fixture();

        const result = yield* finish(
          runTrain(admission).pipe(Effect.provide(test.layer))
        );

        expect(result.exit).toBe("landed");
        expect(result.success).toBe(true);
        const lines = yield* test.sink.lines;
        expect(lines).toEqual(yield* test.store.lines);

        const records = yield* Effect.all(
          lines.map((line) =>
            Schema.decodeEffect(Schema.fromJsonString(TrainRecord))(line)
          )
        );

        expect(records[0]).toMatchObject({
          car: admission.car,
          mode: "live",
          repo: admission.repo,
          start: 1,
        });
        expect(records.at(-1)).toEqual({ exit: "landed" });
        const done = records.filter((record) => "done" in record);
        expect(
          done.map((record) => ("done" in record ? record.done : ""))
        ).toEqual([
          "BuildTrain",
          "OpenTrainPr",
          "PollChecks",
          "MarkReady",
          "Merge",
          "RemoveLabels",
        ]);

        const built = done
          .flatMap((record) => ("events" in record ? record.events : []))
          .find(Predicate.isTagged("built"));

        expect(built).toMatchObject({ head: "built-a", merged: [1] });
        expect(
          records.every(
            (record) => "exit" in record || Predicate.isString(record.at)
          )
        ).toBe(true);
        expect(test.github.writes).toHaveLength(7);
      })
  );

  for (const draft of [false, true]) {
    it.effect(
      `lands a lone ${draft ? "draft" : "ready"} car level with main directly: ready for review, then one merge of its reviewed head, no train branch`,
      () =>
        Effect.gen(function* directLanding() {
          const test = yield* fixture();
          test.github.controls.drafts = draft ? [admission.car.number] : [];

          const result = yield* finish(
            runTrain(direct).pipe(Effect.provide(test.layer))
          );

          expect(result).toEqual({
            exit: "landed",
            stop: undefined,
            success: true,
            writes: 3,
          });
          expect(
            test.github.writes.map(
              (operation) => `${operation.method} ${operation.path}`
            )
          ).toEqual([
            ...(draft ? ["POST /graphql"] : []),
            `PUT /pulls/${admission.car.number}/merge`,
            `DELETE /issues/${admission.car.number}/labels/queue`,
          ]);
          expect(test.github.writes.at(-2)?.body).toEqual({
            merge_method: "merge",
            sha: admission.car.headSha,
          });
          expect(test.github.controls.drafts).toEqual([]);

          const records = yield* recordsOf(yield* test.sink.lines);
          expect(doneKinds(records)).toEqual([
            "MarkReady",
            "Merge",
            "RemoveLabels",
          ]);
          expect(pathsOf(records)).toEqual([
            expect.objectContaining({
              base: "base-a",
              cars: [admission.car.number],
              path: "direct-land",
            }),
          ]);
        })
    );
  }

  it.effect("rehearses a direct landing of a draft car without writing", () =>
    Effect.gen(function* directRehearsal() {
      const test = yield* fixture();
      test.github.controls.drafts = [admission.car.number];

      const result = yield* finish(
        runTrain({ ...direct, mode: "dry-run" }).pipe(
          Effect.provide(
            Layer.merge(
              test.layer,
              Layer.succeed(GitHubWrites, {
                write: () => Effect.die("Dry-run attempted a write"),
              })
            )
          )
        )
      );

      expect(result.exit).toBe("rehearsal complete");
      expect(result.writes).toBe(0);
      expect(test.github.writes).toEqual([]);
      expect(test.github.records).toEqual([
        expect.objectContaining({
          head: admission.car.headSha,
          kind: "MarkReady",
          wouldDo: [
            expect.objectContaining({ method: "POST", path: "/graphql" }),
          ],
        }),
        expect.objectContaining({
          head: admission.car.headSha,
          kind: "Merge",
          wouldDo: [
            expect.objectContaining({
              method: "PUT",
              path: `/pulls/${admission.car.number}/merge`,
            }),
          ],
        }),
      ]);
      expect(test.github.records[0]?.wouldDo[0]?.body).toMatchObject({
        variables: { id: `node-${admission.car.number}` },
      });
    })
  );

  for (const [name, checks, reason] of [
    [
      "its own CI is still running",
      [carCheck("unit", "in_progress", null)],
      "its own CI has not finished",
    ],
    [
      "its own CI lacks a direct group",
      [carCheck("unit", "completed", "success")],
      "its own CI has no success for full",
    ],
  ] as const) {
    it.effect(
      `boards a lone car on push and takes the train when ${name}`,
      () =>
        Effect.gen(function* loneBoard() {
          const test = yield* fixture();
          test.github.controls.candidateChecks = checks;

          const result = yield* finish(
            runTrain({
              ...direct,
              input: {
                ...direct.input,
                directRequiredChecks: [["unit"], ["full"]],
              },
            }).pipe(Effect.provide(test.layer))
          );

          expect(result.exit).toBe("landed");

          const records = yield* recordsOf(yield* test.sink.lines);
          expect(doneKinds(records)[0]).toBe("BuildTrain");
          const paths = pathsOf(records);
          expect(paths).toEqual([
            expect.objectContaining({
              cars: [admission.car.number],
              path: "lone-board",
            }),
          ]);
          expect(paths[0]?.reason).toContain(reason);
        })
    );
  }

  it.effect("rehearses the build with a writes layer that dies on use", () =>
    Effect.gen(function* rehearsed() {
      const test = yield* fixture();

      const result = yield* runTrain({ ...admission, mode: "dry-run" }).pipe(
        Effect.provide(
          Layer.merge(
            test.layer,
            Layer.succeed(GitHubWrites, {
              write: () => Effect.die("Dry-run attempted a write"),
            })
          )
        )
      );

      expect(result).toEqual({
        exit: "rehearsal complete",
        stop: undefined,
        success: true,
        writes: 0,
      });
      expect(test.github.writes).toEqual([]);
      expect(test.github.records).toHaveLength(1);
    })
  );

  it.effect("refuses a live repository without operator admission", () =>
    Effect.gen(function* notAdmitted() {
      const test = yield* fixture();

      const result = yield* runTrain(admission).pipe(
        Effect.provide(test.layer),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({})
        )
      );

      refusal(
        result.stop,
        "LiveNotAdmitted",
        "writing to a repository the operator did not admit",
        "set PIPER_LIVE_ADMITTED_REPO to the admitted repo"
      );
      expect(test.github.reads).toEqual([]);
      expect(test.github.writes).toEqual([]);
    })
  );

  it.effect("requires a named base at the JSON boundary", () =>
    Effect.gen(function* invalid() {
      const result = yield* decodeTrainAdmission({
        ...admission,
        baseBranch: "",
      }).pipe(Effect.flip);

      refusal(
        result,
        "InvalidAdmission",
        "building against an unnamed base",
        "add baseBranch to the admission"
      );
      expect(Predicate.isTagged(result, "InvalidAdmission")).toBe(true);
    })
  );

  it.effect("names the failing admission paths without their values", () =>
    Effect.gen(function* namedPaths() {
      const { repo: _repo, ...input } = admission.input;

      const result = yield* decodeTrainAdmission({
        ...admission,
        goBy: 424_242,
        input,
      }).pipe(Effect.flip);

      refusal(
        result,
        "InvalidAdmission",
        "acting on an invalid admission",
        "fix goBy, input.repo in the admission JSON"
      );
      expect(JSON.stringify(result)).not.toContain("424242");
    })
  );
});
