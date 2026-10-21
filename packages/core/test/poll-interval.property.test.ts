import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { SoloInput } from "../src/domain.js";
import { SoloInputSchema, TrainInputSchema } from "../src/domain.js";
import { input } from "./fixtures.js";

const solo: SoloInput = {
  aggregateChecks: [],
  at: 0,
  base: "synthetic-base",
  checks: [],
  ciTimeoutMs: 60_000,
  head: "synthetic-head",
  ignoredChecks: [],
  owner: "contributor/example",
  pollMs: 90_000,
  pr: 1,
  repo: "example/project",
};

const intervals = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 200_000, minimum: 0 }))
);

const accepts = (pollMs: number) => ({
  solo: Schema.is(SoloInputSchema)({ ...solo, pollMs }),
  train: Schema.is(TrainInputSchema)({ ...input(1), pollMs }),
});

describe("poll intervals", () => {
  it.prop(
    "train and solo inputs accept every poll interval from ten seconds to two minutes and nothing else",
    { pollMs: intervals },
    ({ pollMs }) => {
      const allowed = pollMs >= 10_000 && pollMs <= 120_000;

      expect(accepts(pollMs)).toEqual({ solo: allowed, train: allowed });
    },
    { arbitrary: { runs: 400 } }
  );

  it("accepts a fifteen-second poll and the edges of the range", () => {
    for (const pollMs of [10_000, 15_000, 120_000]) {
      expect(accepts(pollMs)).toEqual({ solo: true, train: true });
    }

    for (const pollMs of [9999, 120_001]) {
      expect(accepts(pollMs)).toEqual({ solo: false, train: false });
    }
  });
});
