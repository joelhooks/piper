import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { CandidateSchema, CheckRunSchema } from "../src/domain.js";
import { openTrain, readTrain, stepTrain } from "../src/host.js";
import { openSolo, readSolo, stepSolo } from "../src/solo-host.js";
import { ciOn, input, T0 } from "./fixtures.js";

const HistorySchema = Schema.Struct({
  candidates: Schema.Array(CandidateSchema),
  checks: Schema.Array(CheckRunSchema),
  delay: Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 0 })),
  flake: Schema.Boolean,
});

export const histories = Arbitrary.schema(HistorySchema);

export const ledgers = Effect.fn("MetricsTest.ledgers")(function* ledgers(
  generated: typeof HistorySchema.Type
) {
  const cars = generated.candidates.slice(0, 8).map((candidate, index) => ({
    ...candidate,
    checks: ciOn(`car-${index}`),
    headSha: `car-${index}`,
    labels: ["train"],
    number: index + 1,
    operatorReviewed: true,
    upToDate: true,
  }));

  let train = yield* openTrain(input(1));

  if (cars.length > 0) {
    train = yield* stepTrain(train, [
      { at: T0, candidates: cars, main: "base", type: "candidates" },
      { at: T0, type: "depart" },
    ]);
    const buildId = (yield* readTrain(train)).context.build?.id ?? 1;
    train = yield* stepTrain(train, [
      {
        at: T0,
        buildId,
        conflicted: [],
        head: "train-head",
        merged: cars.map((car) => car.number),
        type: "built",
      },
      {
        at: T0,
        checks: ciOn("train-head"),
        head: "train-head",
        type: "checks",
      },
      { at: T0, pr: 100, type: "prOpened" },
      { at: T0, by: "operator", head: "train-head", type: "go" },
      {
        at: T0 + generated.delay * 60_000,
        head: "train-head",
        mergeSha: "merge",
        type: "merged",
      },
    ]);
  }

  const names = [
    ...new Set([
      "unit",
      ...generated.checks.slice(0, 3).map((check) => check.name),
    ]),
  ];

  const checks = names.map((name, index) => ({
    attempt: 1,
    conclusion: "failure" as const,
    headSha: "solo-head",
    id: index + 1,
    name,
    status: "completed" as const,
  }));

  const soloInput = {
    aggregateChecks: [],
    at: T0,
    base: "base",
    checks,
    ciTimeoutMs: 3_600_000,
    head: "solo-head",
    ignoredChecks: [],
    owner: "contributor",
    pollMs: 90_000,
    pr: 41,
    repo: "example/project",
  };

  const solo = yield* stepSolo(yield* openSolo(soloInput), [
    {
      at: T0 + 60_000,
      checks: checks.map((check) => ({
        ...check,
        attempt: 2,
        conclusion: generated.flake ? "success" : "failure",
      })),
      head: "solo-head",
      type: "checks",
    },
    { at: T0 + 120_000, reason: "done", type: "dismiss" },
  ]);

  return {
    cars: cars.length,
    solos: [(yield* readSolo(solo)).context.facts],
    trains: [(yield* readTrain(train)).context.facts],
  };
});
