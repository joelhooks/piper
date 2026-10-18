import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { Fact, SoloFact } from "../src/domain.js";
import { metrics, timing, trainMetrics } from "../src/metrics.js";
import { histories, ledgers } from "./metrics-histories.js";

const delays = Arbitrary.array(
  Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 }))
  ),
  { maxLength: 20, minLength: 1 }
);

const rebuilt: Fact = {
  at: 0,
  base: "base",
  cause: "conflict",
  kind: "rebuild",
};

const unrelated: SoloFact = {
  at: 0,
  classes: {
    baseRed: "unknown",
    flake: "unknown",
    infra: "unknown",
    regression: "unknown",
  },
  evidence: 0,
  judge: { inputsDigest: "fixture", model: "judge", version: "fixture" },
  kind: "judged",
};

describe("ledger metrics", () => {
  it.effect.prop(
    "generated train and solo histories are deterministic, immutable and order independent",
    { generated: histories },
    ({ generated }) =>
      Effect.gen(function* scenario() {
        const { trains, solos, cars } = yield* ledgers(generated);
        const before = JSON.stringify({ solos, trains });
        const result = metrics(trains, solos);
        expect(metrics(trains, solos)).toEqual(result);
        expect(
          metrics(
            trains.map((facts) => facts.toReversed()),
            solos.map((facts) => facts.toReversed())
          )
        ).toEqual(result);
        expect(JSON.stringify({ solos, trains })).toBe(before);
        expect(result.prsLandedPerCiRun.landed).toBe(cars);
        expect(result.prsLandedPerCiRun.rate ?? 0).toBeLessThanOrEqual(cars);
        expect(result.solo.checks.length).toBeGreaterThan(0);
        expect(result.solo.outcomes.flake).toBe(Number(generated.flake));

        if (cars > 0) {
          expect(result.greenToMergedMinutes).toEqual({
            median: generated.delay,
            p90: generated.delay,
            samples: 1,
          });
        }
      }),
    { arbitrary: { runs: 100 } }
  );

  it.effect.prop(
    "unrelated facts cannot change landing, timings or solo outcomes",
    { generated: histories },
    ({ generated }) =>
      Effect.gen(function* scenario() {
        const { trains, solos } = yield* ledgers(generated);
        const before = metrics(trains, solos);

        const after = metrics(
          trains.map((facts) => [...facts, rebuilt]),
          solos.map((facts) => [...facts, unrelated])
        );

        expect(after.prsLandedPerCiRun).toEqual(before.prsLandedPerCiRun);
        expect(after.greenToMergedMinutes).toEqual(before.greenToMergedMinutes);
        expect(after.culpritsPerBisect).toEqual(before.culpritsPerBisect);
        expect(after.solo).toEqual(before.solo);
        expect(after.rebuildsByCause.conflict).toBe(
          before.rebuildsByCause.conflict + trains.length
        );
      }),
    { arbitrary: { runs: 100 } }
  );

  it.prop(
    "median divides the sorted population and p90 uses the nearest rank",
    { values: delays },
    ({ values }) => {
      const result = timing(values);
      const sorted = values.toSorted((a, b) => a - b);
      const lower = sorted.at(Math.floor((values.length - 1) / 2)) ?? 0;
      const upper = sorted.at(Math.floor(values.length / 2)) ?? 0;
      expect(result.median).toBe((lower + upper) / 2);
      expect(result.p90).toBe(sorted.at(Math.ceil(values.length * 0.9) - 1));
      expect(timing(values.toReversed())).toEqual(result);
    }
  );

  it("keeps missing evidence unknown and counts an unknown judge's bisect", () => {
    expect(metrics([], []).prsLandedPerCiRun.rate).toBeNull();
    expect(metrics([], []).greenToMergedMinutes).toEqual({
      median: null,
      p90: null,
      samples: 0,
    });

    const facts: readonly Fact[] = [
      {
        at: 60_000,
        cars: [1, 2],
        head: "head",
        kind: "merged",
        mergeSha: "merge",
      },
      {
        at: 0,
        failed: "unavailable",
        head: "head",
        judge: undefined,
        kind: "judged",
        ranks: [],
      },
      { at: 0, kind: "dropped", pr: 3, reason: "culprit" },
    ];

    const result = metrics([facts], [], {
      liveAt: [{ at: 180_000, mergeSha: "merge" }],
    });

    expect(result.greenToMergedMinutes.samples).toBe(0);
    expect(result.mergeToLiveMinutes).toEqual({
      median: 2,
      p90: 2,
      samples: 1,
    });
    expect(result.culpritsPerBisect).toEqual({
      bisects: 1,
      culprits: 1,
      rate: 1,
    });
    expect(
      trainMetrics([...facts, { at: 0, head: "head", kind: "rerun" }]).bisects
    ).toBe(0);
  });

  it("joins timings on the exact head and merge, retaining pre-window green evidence", () => {
    const facts: readonly Fact[] = [
      {
        at: 0,
        head: "head",
        kind: "verdict",
        outcome: "green",
        purpose: "train",
      },
      {
        at: 60_000,
        head: "head",
        kind: "verdict",
        outcome: "green",
        purpose: "train",
      },
      {
        at: 120_000,
        head: "other",
        kind: "verdict",
        outcome: "green",
        purpose: "train",
      },
      {
        at: 120_000,
        head: "head",
        kind: "verdict",
        outcome: "green",
        purpose: "probe",
      },
      {
        at: 180_000,
        cars: [1],
        head: "head",
        kind: "merged",
        mergeSha: "merge",
      },
      {
        at: 240_000,
        head: "head",
        kind: "verdict",
        outcome: "green",
        purpose: "train",
      },
    ];

    const result = metrics([facts], [], {
      liveAt: [
        { at: 120_000, mergeSha: "merge" },
        { at: 200_000, mergeSha: "other" },
        { at: 300_000, mergeSha: "merge" },
        { at: 360_000, mergeSha: "merge" },
      ],
      since: 180_000,
    });

    expect(result.greenToMergedMinutes.median).toBe(2);
    expect(result.mergeToLiveMinutes.median).toBe(2);
    expect(
      metrics([facts], [], { since: 180_001 }).prsLandedPerCiRun.landed
    ).toBe(0);
  });

  it("separates attempt roles from completed outcomes and check-specific flake rates", () => {
    const attempt: SoloFact = {
      at: 0,
      attempt: 1,
      check: "unit",
      conclusion: "failure",
      excerpt: undefined,
      id: 1,
      kind: "attempt",
      role: "original",
      sha: "head",
    };

    const result = metrics(
      [],
      [
        [
          attempt,
          { ...attempt, conclusion: "success", role: "baseline" },
          {
            at: 1,
            checks: ["unit", "unit"],
            detail: "fixture",
            kind: "outcome",
            outcome: "flake",
          },
        ],
        [
          {
            at: 2,
            checks: ["unit", "lint"],
            detail: "fixture",
            kind: "outcome",
            outcome: "regression",
          },
        ],
      ]
    );

    expect(result.solo.outcomes.flake).toBe(1);
    expect(result.solo.checks).toMatchObject([
      { flakeRate: 0, name: "lint" },
      {
        attempts: { baseline: 1, original: 1, rerun: 0 },
        flakeRate: 0.5,
        name: "unit",
      },
    ]);
    expect(metrics([], [[attempt]]).solo.checks[0]?.flakeRate).toBeNull();
  });
});
