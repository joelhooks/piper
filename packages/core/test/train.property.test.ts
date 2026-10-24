import { describe, expect, it } from "@effect/vitest";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { Candidate, TrainEvent } from "../src/domain.js";
import type { TrainSnapshot } from "../src/host.js";
import { openTrain, readTrain, stateName, stepTrain } from "../src/host.js";
import { trainMachine } from "../src/machine.js";
import { DEFAULT_CARS, MAX_CARS } from "../src/policy.js";
import { renderNotification, VocabularySchema } from "../src/vocabulary.js";
import { ciOn, input, JUDGE, T0 } from "./fixtures.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { Rules } from "./train-rules.js";

const StepSchema = Schema.Struct({
  kind: Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 0 })),
  mask: Schema.Int.check(Schema.isBetween({ maximum: 32_767, minimum: 0 })),
  n: Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 })),
  stale: Schema.Boolean,
});

type Step = typeof StepSchema.Type;

const steps = Arbitrary.array(Arbitrary.schema(StepSchema), { maxLength: 60 });

const cap = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: MAX_CARS, minimum: 1 }))
);

const cut = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 0 }))
);

const outcomeOf = (n: number) => {
  if (n < 50) {
    return "green";
  }

  if (n < 72) {
    return "red";
  }

  return n < 84 ? "timeout" : "pending";
};

class World {
  now = T0;
  shas = 0;
  mains = 0;
  main = "main-0";

  fresh(prefix: string) {
    this.shas += 1;

    return `${prefix}-${this.shas}`;
  }

  static pool(step: Step): Candidate[] {
    return Array.from({ length: 1 + (step.n % 15) }, (_, index) => {
      const number = 100 + index;
      const headSha = `pr-${number}`;
      const eligible = Math.floor(step.mask / 2 ** index) % 2 === 1;
      const flaw = (step.n + index) % 4;

      return {
        checks: ciOn(headSha, eligible || flaw !== 0 ? "green" : "red"),
        headSha,
        labels: eligible || flaw !== 2 ? ["train"] : [],
        number,
        operatorReviewed: eligible || flaw !== 1,
        owner: `contributor/lane-${number}`,
        upToDate: eligible || flaw !== 3,
      };
    });
  }

  plan(mask: number): TrainEvent {
    return {
      at: this.now,
      landed: Array.from({ length: 15 }, (_, index) => index)
        .filter((index) => Math.floor(mask / 2 ** index) % 2 === 1)
        .map((index) => `node-${index}`),
      plan: {
        edges: Array.from({ length: 14 }, (_, index) => index + 1)
          .filter((index) => index % 3 === 0)
          .map((index) => ({
            after: `node-${index}`,
            before: `node-${index - 1}`,
          })),
        nodes: Array.from({ length: 15 }, (_, index) => ({
          files: [`src/unit-${index % 10}.ts`],
          id: `node-${index}`,
          pr: 100 + index,
          priority: (index % 3) - 1,
        })),
      },
      type: "plan",
    };
  }

  built(snapshot: TrainSnapshot, step: Step): TrainEvent {
    const { build } = snapshot.context;
    const cars = build?.cars.map((car) => car.number) ?? [];

    const conflicted =
      step.n % 6 === 0
        ? cars.filter(
            (_, index) => Math.floor(step.mask / 2 ** index) % 2 === 1
          )
        : [];

    return {
      at: this.now,
      buildId: step.stale ? (build?.id ?? 0) - 1 : (build?.id ?? 0),
      conflicted,
      head: this.fresh(build?.purpose ?? "train"),
      merged: cars.filter((pr) => !conflicted.includes(pr)),
      type: "built",
    };
  }

  checks(snapshot: TrainSnapshot, step: Step): TrainEvent {
    const head = step.stale
      ? "some-old-head"
      : (snapshot.context.head ?? "none");

    return {
      at: this.now,
      checks: ciOn(head, outcomeOf(step.n)),
      head,
      type: "checks",
    };
  }

  ranked(snapshot: TrainSnapshot, step: Step): TrainEvent {
    const head = step.stale
      ? "some-old-head"
      : (snapshot.context.red?.head ?? "none");

    if (step.n < 10) {
      return {
        at: this.now,
        head,
        reason: "judge unavailable",
        type: "rankFailed",
      };
    }

    return {
      at: this.now,
      head,
      judge: JUDGE,
      ranks: snapshot.context.cars.map((car, index) => {
        const bits = Math.floor(step.mask / 2 ** (index * 2)) % 4;

        return {
          evidence:
            bits === 1
              ? [{ detail: "src/ingress.ts", kind: "path" as const }]
              : [],
          p:
            bits === 3 && step.n % 2 === 0
              ? ("unknown" as const)
              : bits / 10 + (step.n % 3 === 0 ? 0 : 0.15 * (index % 2)),
          pr: car.number,
        };
      }),
      type: "ranked",
    };
  }

  mainMoved(): TrainEvent {
    this.mains += 1;
    this.main = `main-${this.mains}`;

    return { at: this.now, main: this.main, type: "mainMoved" };
  }

  go(snapshot: TrainSnapshot, step: Step): TrainEvent {
    return {
      at: this.now,
      by: "operator",
      head: step.stale ? "some-old-head" : (snapshot.context.head ?? "none"),
      type: "go",
    };
  }

  merged(snapshot: TrainSnapshot, step: Step): TrainEvent {
    const head = step.stale
      ? "some-old-head"
      : (snapshot.context.head ?? "none");

    return {
      at: this.now,
      head,
      mergeSha: this.fresh("merge"),
      type: "merged",
    };
  }

  progress(snapshot: TrainSnapshot, step: Step): TrainEvent {
    const state = stateName(snapshot);

    if (state === "collecting") {
      return snapshot.context.pool.length === 0 || step.n % 5 === 0
        ? {
            at: this.now,
            candidates: World.pool(step),
            main: this.main,
            type: "candidates",
          }
        : { at: this.now, type: "depart" };
    }

    if (state === "building" || state === "bisecting.building") {
      return this.built(snapshot, step);
    }

    if (state === "testing.polling" || state === "bisecting.testing") {
      if (step.n % 9 === 0) {
        const due =
          step.n % 2 === 0
            ? snapshot.context.ciDeadlineAt
            : snapshot.context.pollAt;

        this.now = Math.max(this.now, (due ?? this.now) + step.n);

        return { at: this.now, type: "tick" };
      }

      return this.checks(snapshot, step);
    }

    if (state === "testing.triaging") {
      return this.ranked(snapshot, step);
    }

    if (state === "landing.awaitingGo") {
      return snapshot.context.pr === undefined
        ? { at: this.now, pr: 9000 + snapshot.context.train, type: "prOpened" }
        : this.go(snapshot, step);
    }

    return step.n < 85
      ? this.merged(snapshot, step)
      : {
          at: this.now,
          head: snapshot.context.head ?? "none",
          reason: "head moved",
          type: "mergeRefused",
        };
  }

  next(snapshot: TrainSnapshot, step: Step): TrainEvent | undefined {
    this.now += 60_000;

    switch (step.kind) {
      case 7: {
        return {
          at: this.now,
          candidates: World.pool(step),
          main: this.main,
          type: "candidates",
        };
      }

      case 8: {
        return { at: this.now, type: "depart" };
      }

      case 9: {
        return this.built(snapshot, step);
      }

      case 10: {
        return this.checks(snapshot, step);
      }

      case 11: {
        this.now += step.n * 60_000;

        return { at: this.now, type: "tick" };
      }

      case 12: {
        return this.ranked(snapshot, step);
      }

      case 13: {
        return this.mainMoved();
      }

      case 14: {
        return this.go(snapshot, step);
      }

      case 15: {
        return this.merged(snapshot, step);
      }

      case 16: {
        return {
          at: this.now,
          head: snapshot.context.head ?? "none",
          reason: "refused",
          type: "mergeRefused",
        };
      }

      case 17: {
        return {
          at: this.now,
          pr: 9000 + snapshot.context.train,
          type: "prOpened",
        };
      }

      case 18: {
        return step.n < 15
          ? {
              at: this.now,
              buildId: snapshot.context.build?.id ?? 0,
              reason: "push rejected",
              type: "buildFailed",
            }
          : this.progress(snapshot, step);
      }

      case 19: {
        return step.n < 5
          ? {
              at: this.now,
              reason: "operator stopped the line",
              type: "abandon",
            }
          : this.progress(snapshot, step);
      }

      case 20: {
        return this.plan(step.mask);
      }

      default: {
        return this.progress(snapshot, step);
      }
    }
  }
}

const runLive = Effect.fn("runLive")(function* runLive(
  generated: readonly Step[],
  maxCars: number,
  withPlan?: boolean
) {
  const actor = yield* createEffectActor(trainMachine, {
    input: input(7, maxCars),
  });

  const world = new World();
  const rules = new Rules(maxCars);
  let token = 0;

  if (withPlan === true) {
    const before = actor.getSnapshot();
    const event = world.plan(0);

    yield* send(actor, event);
    yield* send(actor, { token: 0, type: "sync" });

    const after = yield* waitFor(
      actor,
      (snapshot) => snapshot.context.plan !== undefined
    );

    rules.check(before, event, after);
  }

  for (const step of generated) {
    const before = actor.getSnapshot();

    if (before.status !== "active") {
      break;
    }

    const event = world.next(before, step);

    if (event === undefined) {
      continue;
    }

    token += 1;
    yield* send(actor, event);
    yield* send(actor, { token, type: "sync" });

    const expectedToken = token;

    const after = yield* waitFor(
      actor,
      (snapshot) =>
        snapshot.status !== "active" || snapshot.context.sync === expectedToken
    );

    rules.check(before, event, after);
  }

  return { persisted: actor.getPersistedSnapshot(), rules };
}, Effect.scoped);

const runRestored = Effect.fn("runRestored")(function* runRestored(
  events: readonly TrainEvent[],
  at: number,
  maxCars: number
) {
  const split = Math.min(at, events.length);

  const actor = yield* createEffectActor(trainMachine, {
    input: input(7, maxCars),
  });

  for (const event of events.slice(0, split)) {
    yield* send(actor, event);
  }

  yield* send(actor, { token: -1, type: "sync" });
  yield* waitFor(
    actor,
    (snapshot) => snapshot.status !== "active" || snapshot.context.sync === -1
  );

  const saved = jsonSnapshot(actor.getPersistedSnapshot());

  const rest = events.slice(split);

  return rest.length === 0 || saved.status !== "active"
    ? saved
    : yield* stepTrain(saved, rest);
}, Effect.scoped);

const comparable = (snapshot: TrainSnapshot) => {
  const { context, status, value } = snapshot;
  const { sync: _sync, ...rest } = context;

  return { context: rest, status, value };
};

const TWO_HUNDRED_TRACES_WITH_A_CI_RUNNER_BUDGET = {
  arbitrary: { runs: 200, size: 100 },
  timeout: 30_000,
};

describe("train lifecycle rules over generated traces", () => {
  it.effect.prop(
    "cars within the cap, landing only green on the exact head after GO, bisect removes a car, main moves rebuild",
    { generated: steps, maxCars: cap },
    ({ generated, maxCars }) =>
      Effect.gen(function* scenario1() {
        yield* runLive(generated, maxCars);
      }),
    { arbitrary: { runs: 400, size: 100 } }
  );

  it.effect.prop(
    "a train restored from JSON at any point ends where the uninterrupted train ends",
    { at: cut, generated: steps, maxCars: cap },
    ({ at, generated, maxCars }) =>
      Effect.gen(function* scenario2() {
        const live = yield* runLive(generated, maxCars);
        const restored = yield* runRestored(live.rules.posted, at, maxCars);

        expect(comparable(yield* readTrain(restored))).toEqual(
          comparable(yield* readTrain(live.persisted))
        );
      }),
    TWO_HUNDRED_TRACES_WITH_A_CI_RUNNER_BUDGET
  );

  it.effect.prop(
    "a nonempty plan preserves landing safety and JSON restoration through generated traces",
    { at: cut, generated: steps, maxCars: cap },
    ({ at, generated, maxCars }) =>
      Effect.gen(function* plannedRestoration() {
        const live = yield* runLive(generated, maxCars, true);
        const restored = yield* runRestored(live.rules.posted, at, maxCars);

        expect(comparable(yield* readTrain(restored))).toEqual(
          comparable(yield* readTrain(live.persisted))
        );
      }),
    TWO_HUNDRED_TRACES_WITH_A_CI_RUNNER_BUDGET
  );

  it.effect.prop(
    "rendering with any decodable vocabulary changes no train outcome, intent or ledger fact",
    {
      generated: steps,
      maxCars: cap,
      vocabulary: Arbitrary.schema(VocabularySchema),
    },
    ({ generated, maxCars, vocabulary }) =>
      Effect.gen(function* vocabularyIndependence() {
        const live = yield* runLive(generated, maxCars);
        let rendered = yield* openTrain(input(7, maxCars));

        for (const event of live.rules.posted) {
          rendered = yield* stepTrain(rendered, [event]);
          const snapshot = yield* readTrain(rendered);

          for (const intent of snapshot.context.intents) {
            renderNotification(intent, vocabulary);
          }
        }

        expect(comparable(yield* readTrain(rendered))).toEqual(
          comparable(yield* readTrain(live.persisted))
        );
      }),
    TWO_HUNDRED_TRACES_WITH_A_CI_RUNNER_BUDGET
  );

  it.effect("the generator reaches every rule it claims to check", () =>
    Effect.gen(function* scenario3() {
      const totals = { bisects: 0, landed: 0, rebuilt: 0, widerThanFive: 0 };

      const samples = yield* Arbitrary.sampleEffect(steps, {
        count: 300,
        seed: 7,
        size: 100,
      }).pipe(Effect.orDie);

      for (const generated of samples) {
        const { rules } = yield* runLive(generated, DEFAULT_CARS);
        totals.widerThanFive += rules.widest > 5 ? 1 : 0;
        totals.bisects += rules.bisects;
        totals.landed += rules.landed;
        totals.rebuilt += rules.rebuilt;
      }

      expect(totals.landed).toBeGreaterThan(10);
      expect(totals.bisects).toBeGreaterThan(10);
      expect(totals.rebuilt).toBeGreaterThan(10);
      expect(totals.widerThanFive).toBeGreaterThan(10);
    })
  );
});
