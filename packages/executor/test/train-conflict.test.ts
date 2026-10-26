import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { runTrain } from "../src/train.js";
import { admission, finish, fixture } from "./train-fixture.js";

it.effect(
  "hands back the merge conflict even when the provider says mergeable",
  () =>
    Effect.gen(function* conflict() {
      const test = yield* fixture();
      test.github.controls.conflict = true;

      const result = yield* finish(
        runTrain(admission).pipe(Effect.provide(test.layer))
      );

      expect(result.stop?._tag).toBe("Conflict");
      expect(result.stop).toMatchObject({
        harm: "landing a car that doesn't merge onto main",
        next: "merge main into the car, then GO it again",
        stop: "conflict with main",
      });
      expect(
        test.github.writes.filter((write) => write.path.endsWith("/merge"))
      ).toEqual([]);
      expect(
        test.github.writes.filter((write) => write.path.endsWith("/comments"))
      ).toEqual([]);
    })
);
