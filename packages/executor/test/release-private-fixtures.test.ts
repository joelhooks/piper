import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  ReleaseExpectationSchema,
  ReleasePlanSchema,
} from "@joelhooks/piper/release-domain";
import {
  openRelease,
  readRelease,
  stepRelease,
} from "@joelhooks/piper/release-host";
import { checkReleaseExpectation } from "@joelhooks/piper/release-policy";
import { Effect, FileSystem, Schema } from "effect";

import { releaseInput } from "../../core/test/release-fixtures.js";

const directory = process.env.PIPER_RELEASE_FIXTURES;

describe.skipIf(directory === undefined)(
  "private release fixtures (set PIPER_RELEASE_FIXTURES to a directory with plan.json and expectation.json)",
  () => {
    it.effect(
      "captured rows pass without the stop rows and hold with them",
      () =>
        Effect.gen(function* privateFixtures() {
          const fs = yield* FileSystem.FileSystem;

          const plan = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(ReleasePlanSchema)
          )(yield* fs.readFileString(`${directory}/plan.json`));

          const expectation = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(ReleaseExpectationSchema)
          )(yield* fs.readFileString(`${directory}/expectation.json`));

          const violations = checkReleaseExpectation(plan, expectation);

          const stop = violations.flatMap((violation) =>
            violation.reason === "stop" ? [violation.row] : []
          );

          expect(stop.length > 0).toBe(true);
          const allowed = plan.filter((row) => !stop.includes(row));
          expect(
            checkReleaseExpectation(allowed, expectation).length === 0
          ).toBe(true);
          const initial = yield* openRelease({ ...releaseInput, expectation });

          const held = yield* stepRelease(initial, [
            { at: 101, rows: plan, type: "planned" },
          ]);

          const heldSnapshot = yield* readRelease(held);

          expect(heldSnapshot.matches("held")).toBe(true);
          expect(
            heldSnapshot.context.facts
              .at(-1)
              ?.offending?.some((violation) => violation.reason === "stop")
          ).toBe(true);

          const passed = yield* stepRelease(initial, [
            { at: 101, rows: allowed, type: "planned" },
          ]);

          expect((yield* readRelease(passed)).matches("review")).toBe(true);
        }).pipe(Effect.provide(NodeFileSystem.layer))
    );
  }
);
