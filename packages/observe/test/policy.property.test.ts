import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  deploymentVerdict,
  errorsVerdict,
  isSuperseded,
} from "../src/policy.js";

const errorCount = Schema.Int.check(
  Schema.isBetween({ maximum: 30, minimum: 0 })
);

const requestCount = Schema.Int.check(
  Schema.isBetween({ maximum: 300, minimum: 0 })
);

const minimum = Schema.Int.check(Schema.isBetween({ maximum: 50, minimum: 1 }));

const ratio = Schema.Finite.check(
  Schema.isBetween({ maximum: 10, minimum: 0.5 })
);

const settings = {
  afterErrors: Arbitrary.schema(errorCount),
  afterRequests: Arbitrary.schema(requestCount),
  beforeErrors: Arbitrary.schema(errorCount),
  beforeRequests: Arbitrary.schema(requestCount),
  hardFloorErrors: Arbitrary.schema(errorCount),
  maxRateRatio: Arbitrary.schema(ratio),
  minRequests: Arbitrary.schema(minimum),
};

interface Sample {
  readonly afterErrors: number;
  readonly afterRequests: number;
  readonly beforeErrors: number;
  readonly beforeRequests: number;
  readonly hardFloorErrors: number;
  readonly maxRateRatio: number;
  readonly minRequests: number;
}

const verdict = (sample: Sample, afterErrors = sample.afterErrors) =>
  errorsVerdict(
    {
      dataset: "synthetic-logs",
      filter: "true",
      hardFloorErrors: sample.hardFloorErrors,
      maxRateRatio: sample.maxRateRatio,
      minRequests: sample.minRequests,
      statusField: "status",
      windowMinutes: 15,
    },
    {
      errors: Math.min(sample.beforeErrors, sample.beforeRequests),
      requests: sample.beforeRequests,
    },
    {
      errors: Math.min(afterErrors, sample.afterRequests),
      requests: sample.afterRequests,
    }
  );

describe("deployment verdict", () => {
  it.prop(
    "only failed builds are build-failed and only a serving READY deploy passes",
    {
      serving: Arbitrary.schema(Schema.Boolean),
      state: Arbitrary.schema(
        Schema.Literals([
          "BLOCKED",
          "BUILDING",
          "CANCELED",
          "DELETED",
          "ERROR",
          "INITIALIZING",
          "QUEUED",
          "READY",
        ])
      ),
    },
    ({ serving, state }) => {
      const outcome = deploymentVerdict(state, serving);

      expect(outcome === "build-failed").toBe(
        ["ERROR", "CANCELED"].includes(state)
      );
      expect(outcome === "pass").toBe(state === "READY" && serving);
      expect(outcome === "unknown").toBe(
        !["ERROR", "CANCELED"].includes(state) &&
          !(state === "READY" && serving)
      );
    }
  );

  it.prop(
    "supersession needs a different, strictly newer target and proven ancestry",
    {
      history: Arbitrary.schema(
        Schema.Array(
          Schema.Struct({
            contains: Schema.Literals(["yes", "no", "unknown"]),
            distance: minimum,
            position: Schema.Literals(["older", "concurrent", "newer"]),
            sameId: Schema.Boolean,
          })
        ).check(Schema.isMinLength(1))
      ),
      releaseCreated: Arbitrary.schema(errorCount),
    },
    ({ history, releaseCreated }) => {
      for (const { contains, distance, position, sameId } of history) {
        const offset = { concurrent: 0, newer: distance, older: -distance }[
          position
        ];

        const result = isSuperseded(
          { created: releaseCreated, id: "dpl_release" },
          {
            created: releaseCreated + offset,
            id: sameId ? "dpl_release" : "dpl_target",
          },
          contains
        );

        expect(result).toBe(
          position === "newer" && !sameId && contains === "yes"
        );
      }
    }
  );
});

describe("errors verdict", () => {
  it("passes a rate spike that stays exactly at the hard floor", () => {
    const sample = {
      afterErrors: 5,
      afterRequests: 1000,
      beforeErrors: 0,
      beforeRequests: 1000,
      hardFloorErrors: 5,
      maxRateRatio: 2,
      minRequests: 1000,
    };

    expect(verdict(sample)).toBe("pass");
    expect(verdict(sample, 6)).toBe("breach");
  });

  it.prop(
    "is unknown exactly when after requests are below the minimum",
    settings,
    (sample) => {
      expect(verdict(sample) === "unknown").toBe(
        sample.afterRequests < sample.minRequests
      );
    }
  );

  it.prop(
    "never breaches at or under the hard floor of after errors",
    settings,
    (sample) => {
      expect(
        Math.min(sample.afterErrors, sample.afterRequests) <=
          sample.hardFloorErrors && verdict(sample) === "breach"
      ).toBe(false);
    }
  );

  it.prop(
    "never breaches at or under the 1/minRequests rate",
    settings,
    (sample) => {
      const errors = Math.min(sample.afterErrors, sample.afterRequests);

      expect(
        errors * sample.minRequests <= sample.afterRequests &&
          verdict(sample) === "breach"
      ).toBe(false);
    }
  );

  it.prop(
    "adding after errors never turns a breach into a pass",
    settings,
    (sample) => {
      expect(
        verdict(sample) === "breach" &&
          verdict(sample, sample.afterErrors + 1) !== "breach"
      ).toBe(false);
    }
  );
});
