import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { errorsVerdict } from "../src/policy.js";

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
