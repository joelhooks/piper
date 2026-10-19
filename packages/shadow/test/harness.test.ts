import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { runRecording } from "../src/runner.js";
import { loadRecordings } from "../src/storage.js";

const scenario = Effect.fn("Test.scenario")(function* scenario(name: string) {
  const recordings = yield* loadRecordings(
    `packages/shadow/test/fixtures/${name}`
  );

  const [recording] = recordings;

  expect(recording).toBeDefined();

  if (recording === undefined) {
    return yield* Effect.die("Missing fixture");
  }

  const first = yield* runRecording(recording);
  const second = yield* runRecording(recording);
  expect(second).toEqual(first);

  return first;
}, Effect.provide(NodeServices.layer));

describe("offline shadow", () => {
  it.effect(
    "missing offline reads fail closed instead of falling back to GitHub",
    () =>
      Effect.gen(function* test() {
        const [recording] = yield* loadRecordings(
          "packages/shadow/test/fixtures/clean"
        );

        if (recording === undefined) {
          return yield* Effect.die("Missing fixture");
        }

        const result = yield* runRecording({
          ...recording,
          frames: recording.frames.map((frame) => ({ ...frame, reads: [] })),
        }).pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);

        return yield* Effect.void;
      }).pipe(Effect.provide(NodeServices.layer))
  );

  for (const name of ["clean", "bisect", "main-moved"]) {
    it.effect(
      `${name}: machine plus real executor match a synthetic operator`,
      () =>
        Effect.gen(function* test() {
          const report = yield* scenario(name);
          expect(
            report.comparison,
            JSON.stringify(report.expected)
          ).toMatchObject({ differences: [], status: "match" });
          expect(report.view.state).toBe("landed");
          expect(report.journal.length).toBeGreaterThan(0);
        })
    );
  }

  for (const [name, kind] of [
    ["hand-fix", "different cars"],
    ["different-head", "different head"],
  ]) {
    it.effect(`${name}: reports a difference`, () =>
      Effect.gen(function* test() {
        const report = yield* scenario(name ?? "");
        expect(report.comparison.status).toBe("diff");
        expect(
          report.comparison.differences.some(
            (difference) => difference.kind === kind
          )
        ).toBe(true);
      })
    );
  }
});
