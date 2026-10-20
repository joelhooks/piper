import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Predicate, Schema } from "effect";

import { ExecutorError } from "../src/domain.js";
import { Recorder } from "../src/recorder.js";
import type { TrainStop } from "../src/train-domain.js";
import { TrainRecord } from "../src/train-domain.js";
import { decodeTrainAdmission, runTrain } from "../src/train.js";
import { GitHubWrites } from "../src/writes.js";
import { admission, finish, fixture } from "./train-fixture.js";

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
});
