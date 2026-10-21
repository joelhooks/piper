import { describe, expect, it } from "@effect/vitest";
import { Effect, Match, Predicate, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type {
  Candidate,
  CheckRun,
  Fact,
  Intent,
  TrainEvent,
  TrainInput,
} from "../src/domain.js";
import type { PersistedTrain } from "../src/host.js";
import { openTrain, readTrain, stateName, stepTrain } from "../src/host.js";
import { input, T0 } from "./fixtures.js";
import { jsonSnapshot } from "./json-snapshot.js";

const CheckStateSchema = Schema.Literals([
  "absent",
  "pending",
  "success",
  "neutral",
  "skipped",
  "failure",
  "cancelled",
]);

type CheckState = typeof CheckStateSchema.Type;

const LoneCarSchema = Schema.Struct({
  aggregate: CheckStateSchema,
  current: Schema.Boolean,
  direct: Schema.Boolean,
  full: CheckStateSchema,
  labeled: Schema.Boolean,
  light: CheckStateSchema,
  requireUpToDate: Schema.Boolean,
  reviewed: Schema.Boolean,
  stale: CheckStateSchema,
});

type LoneCar = typeof LoneCarSchema.Type;

const cars = Arbitrary.schema(LoneCarSchema);

const StepSchema = Schema.Literals([
  "go",
  "staleGo",
  "mainMoved",
  "sameMain",
  "merged",
  "staleMerged",
  "refused",
  "tick",
  "candidates",
]);

type Step = typeof StepSchema.Type;

const steps = Arbitrary.array(Arbitrary.schema(StepSchema), { maxLength: 12 });

const HEAD = "car-head";

const MAIN = "main-0";

const CAR = 41;

const runOf = (name: string, state: CheckState): readonly CheckRun[] =>
  Match.value(state).pipe(
    Match.when("absent", () => []),
    Match.when("pending", () => [
      {
        conclusion: null,
        headSha: HEAD,
        name,
        status: "in_progress" as const,
      },
    ]),
    Match.orElse((conclusion) => [
      { conclusion, headSha: HEAD, name, status: "completed" as const },
    ])
  );

const candidateOf = (car: LoneCar, number = CAR): Candidate => ({
  checks: [
    ...runOf("light", car.light),
    ...runOf("full", car.full),
    ...runOf("checks", car.aggregate),
    ...runOf("branch-current", car.stale),
  ],
  headSha: HEAD,
  labels: car.labeled ? ["train"] : [],
  number,
  operatorReviewed: car.reviewed,
  owner: "contributor/lone",
  upToDate: car.current,
});

const partner: Candidate = {
  checks: [
    {
      conclusion: "success",
      headSha: "partner",
      name: "light",
      status: "completed",
    },
  ],
  headSha: "partner",
  labels: ["train"],
  number: 42,
  operatorReviewed: true,
  owner: "contributor/partner",
  upToDate: true,
};

const rulesFor = (car: LoneCar): TrainInput => ({
  ...input(9, 2),
  candidateIgnoredChecks: ["checks"],
  candidateRequiredChecks: [["light"]],
  directRequiredChecks: car.direct ? [["checks"], ["full"]] : [],
  requireUpToDate: car.requireUpToDate,
});

const failed = (state: CheckState) =>
  state === "failure" || state === "cancelled";

const passed = (state: CheckState) =>
  state === "success" || state === "neutral";

const admitted = (car: LoneCar) =>
  car.labeled &&
  car.reviewed &&
  (!car.requireUpToDate || car.current) &&
  !failed(car.light) &&
  !failed(car.full);

const trainGreen = (car: LoneCar) =>
  [car.light, car.full, car.aggregate].every(
    (state) => state !== "pending" && !failed(state)
  );

const expectedPath = (car: LoneCar) => {
  if (!admitted(car)) {
    return "refused";
  }

  return car.direct &&
    car.current &&
    trainGreen(car) &&
    passed(car.aggregate) &&
    passed(car.full)
    ? "direct-land"
    : "lone-board";
};

const departures = (facts: readonly Fact[]) =>
  facts.flatMap((fact) => (fact.kind === "departed" ? [fact] : []));

const kinds = (intents: readonly Intent[]) =>
  intents.map((intent) => intent.kind);

const depart = Effect.fn("LoneCar.depart")(function* depart(
  car: LoneCar,
  pool: readonly Candidate[]
) {
  const opened = yield* openTrain(rulesFor(car));

  return yield* stepTrain(opened, [
    { at: T0, candidates: pool, main: MAIN, type: "candidates" },
    { at: T0, type: "depart" },
  ]);
});

const eventOf = (step: Step, at: number, main: string): TrainEvent =>
  Match.value(step).pipe(
    Match.when("go", () => ({
      at,
      by: "operator",
      head: HEAD,
      type: "go" as const,
    })),
    Match.when("staleGo", () => ({
      at,
      by: "operator",
      head: "other-head",
      type: "go" as const,
    })),
    Match.when("mainMoved", () => ({
      at,
      main: `main-${at}`,
      type: "mainMoved" as const,
    })),
    Match.when("sameMain", () => ({ at, main, type: "mainMoved" as const })),
    Match.when("merged", () => ({
      at,
      head: HEAD,
      mergeSha: `merge-${at}`,
      type: "merged" as const,
    })),
    Match.when("staleMerged", () => ({
      at,
      head: "other-head",
      mergeSha: `merge-${at}`,
      type: "merged" as const,
    })),
    Match.when("refused", () => ({
      at,
      head: HEAD,
      reason: "synthetic refusal",
      type: "mergeRefused" as const,
    })),
    Match.when("tick", () => ({ at, type: "tick" as const })),
    Match.orElse(() => ({
      at,
      candidates: [],
      main,
      type: "candidates" as const,
    }))
  );

const directCar: LoneCar = {
  aggregate: "success",
  current: true,
  direct: true,
  full: "success",
  labeled: true,
  light: "success",
  requireUpToDate: false,
  reviewed: true,
  stale: "failure",
};

const CheckFlawSchema = Schema.Struct({
  check: Schema.Literals(["aggregate", "light", "full", "stale"]),
  state: CheckStateSchema,
});

const SwitchFlawSchema = Schema.Literals([
  "behind",
  "strict",
  "off",
  "unlabeled",
  "unreviewed",
]);

const FlawSchema = Schema.Union([CheckFlawSchema, SwitchFlawSchema]);

const flaws = Arbitrary.array(Arbitrary.schema(FlawSchema), { maxLength: 2 });

const switched = (car: LoneCar, flaw: typeof SwitchFlawSchema.Type): LoneCar =>
  Match.value(flaw).pipe(
    Match.when("behind", () => ({ ...car, current: false })),
    Match.when("strict", () => ({ ...car, requireUpToDate: true })),
    Match.when("off", () => ({ ...car, direct: false })),
    Match.when("unlabeled", () => ({ ...car, labeled: false })),
    Match.orElse(() => ({ ...car, reviewed: false }))
  );

const nearDirect = (generated: readonly (typeof FlawSchema.Type)[]) => {
  let car = directCar;

  for (const flaw of generated) {
    car = Predicate.isString(flaw)
      ? switched(car, flaw)
      : { ...car, [flaw.check]: flaw.state };
  }

  return car;
};

const departsByPath = Effect.fn("LoneCar.departsByPath")(
  function* departsByPath(car: LoneCar) {
    const alone = yield* readTrain(yield* depart(car, [candidateOf(car)]));
    const path = expectedPath(car);

    if (path === "refused") {
      expect(stateName(alone)).toBe("collecting");
      expect(alone.context.intents).toEqual([]);
      expect(alone.context.facts).toEqual([]);
    } else {
      expect(departures(alone.context.facts)).toEqual([
        expect.objectContaining({ base: MAIN, cars: [CAR], path }),
      ]);
      expect(stateName(alone)).toBe(
        path === "direct-land" ? "direct.awaitingGo" : "building"
      );
      expect(kinds(alone.context.intents)).toEqual(
        path === "direct-land" ? [] : ["BuildTrain"]
      );
    }

    const shared = yield* readTrain(
      yield* depart(car, [candidateOf(car), partner])
    );

    const boarded = admitted(car) && passed(car.light) ? [CAR, 42] : [42];

    expect(shared.context.cars.map((entry) => entry.number)).toEqual(boarded);
    expect(departures(shared.context.facts)).toEqual([
      expect.objectContaining({ cars: boarded, path: "train" }),
    ]);
    expect(stateName(shared)).toBe("building");
  }
);

describe("lone car fast paths", () => {
  it.effect.prop(
    "a lone car departs by the expected path, and a car sharing its group keeps the light-done rule",
    { car: cars },
    ({ car }) => departsByPath(car),
    { arbitrary: { runs: 400 } }
  );

  it.effect.prop(
    "each flaw near the direct boundary sends the car down the expected path",
    { generated: flaws },
    ({ generated }) => departsByPath(nearDirect(generated)),
    { arbitrary: { runs: 400 } }
  );

  it.effect.prop(
    "a direct landing merges only the car's own head after GO on the unmoved main, falls back to a train otherwise, and restores from JSON",
    { generated: steps },
    ({ generated }) =>
      Effect.gen(function* directTrace() {
        const departed = yield* depart(directCar, [candidateOf(directCar)]);
        let train: PersistedTrain = departed;
        let main = MAIN;
        let at = T0;
        const events: TrainEvent[] = [];

        for (const step of generated) {
          at += 60_000;
          const event = eventOf(step, at, main);
          const before = yield* readTrain(train);

          if (before.status !== "active") {
            break;
          }

          events.push(event);
          train = jsonSnapshot(yield* stepTrain(train, [event]));
          const after = yield* readTrain(train);

          const fresh = after.context.intents.slice(
            before.context.intents.length
          );

          for (const merge of fresh.filter(
            (intent) => intent.kind === "Merge"
          )) {
            expect(fresh).toEqual([
              expect.objectContaining({ kind: "MarkReady", pr: CAR }),
              merge,
            ]);
            expect(merge).toMatchObject({ matchHead: HEAD, pr: CAR });
            expect(event).toMatchObject({ head: HEAD, type: "go" });
            expect(stateName(before)).toBe("direct.awaitingGo");
            expect(before.context.main).toBe(MAIN);
            expect(before.context.build).toBeUndefined();
          }

          if (stateName(after) === "landed") {
            expect(stateName(before)).toBe("direct.merging");
            expect(event).toMatchObject({ head: HEAD, type: "merged" });
            expect(fresh).toEqual([
              expect.objectContaining({
                kind: "RemoveLabels",
                label: "train",
                prs: [CAR],
              }),
            ]);
          }

          if (
            stateName(before).startsWith("direct.") &&
            stateName(after) === "building"
          ) {
            const base =
              event.type === "mainMoved" ? event.main : before.context.main;

            expect(fresh).toEqual([
              expect.objectContaining({
                base,
                cars: [expect.objectContaining({ headSha: HEAD, number: CAR })],
                kind: "BuildTrain",
              }),
            ]);
            expect(departures(after.context.facts).at(-1)).toMatchObject({
              base,
              cars: [CAR],
              path: "train",
            });
          }

          if (event.type === "mainMoved") {
            ({ main } = event);
          }
        }

        const batched = yield* readTrain(
          events.length === 0 ? departed : yield* stepTrain(departed, events)
        );

        const stepped = yield* readTrain(train);
        expect(stepped.value).toEqual(batched.value);
        expect(stepped.context.intents).toEqual(batched.context.intents);
        expect(stepped.context.facts).toEqual(batched.context.facts);
      }),
    { arbitrary: { runs: 400 } }
  );

  it.effect("the flaw generator reaches every departure path", () =>
    Effect.gen(function* everyPath() {
      const samples = yield* Arbitrary.sampleEffect(flaws, {
        count: 300,
        seed: 13,
      }).pipe(Effect.orDie);

      const reached = new Set(
        samples.map((generated) => expectedPath(nearDirect(generated)))
      );

      expect([...reached].toSorted()).toEqual([
        "direct-land",
        "lone-board",
        "refused",
      ]);
    })
  );

  it.effect(
    "the direct trace generator reaches landing and both fallbacks",
    () =>
      Effect.gen(function* reach() {
        const samples = yield* Arbitrary.sampleEffect(steps, {
          count: 300,
          seed: 11,
        }).pipe(Effect.orDie);

        const reached = new Set<string>();

        for (const generated of samples) {
          let train = yield* depart(directCar, [candidateOf(directCar)]);
          let at = T0;

          for (const step of generated) {
            at += 60_000;
            const before = yield* readTrain(train);

            if (before.status !== "active") {
              break;
            }

            train = yield* stepTrain(train, [eventOf(step, at, MAIN)]);
            const after = yield* readTrain(train);

            if (stateName(after) !== stateName(before)) {
              reached.add(`${stateName(before)} -> ${stateName(after)}`);
            }
          }
        }

        expect([...reached].toSorted()).toEqual([
          "direct.awaitingGo -> building",
          "direct.awaitingGo -> direct.merging",
          "direct.merging -> building",
          "direct.merging -> landed",
        ]);
      })
  );
});
