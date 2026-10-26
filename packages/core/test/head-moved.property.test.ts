import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { TrainEvent } from "../src/domain.js";
import { openTrain, readTrain, stateName, stepTrain } from "../src/host.js";
import { metrics } from "../src/metrics.js";
import { plain, renderNotification } from "../src/vocabulary.js";
import { ciOn, input, T0 } from "./fixtures.js";
import { Rules } from "./train-rules.js";

const history = Arbitrary.schema(
  Schema.Struct({
    count: Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 1 })),
    moved: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 })),
    phase: Schema.Literals(["building", "testing", "awaitingGo", "merging"]),
    stale: Schema.Boolean,
  })
);

it.effect.prop(
  "a head move removes only its car and rebuilds unless merge was dispatched",
  { history },
  ({ history: trace }) =>
    Effect.gen(function* headMove() {
      const rules = new Rules(6);
      let train = yield* openTrain(input(1, 6));

      const post = Effect.fn("HeadMovedTest.post")(function* post(
        event: TrainEvent
      ) {
        const before = yield* readTrain(train);
        train = yield* stepTrain(train, [event]);
        const after = yield* readTrain(train);
        rules.check(before, event, after);

        return after;
      });

      const candidates = Array.from({ length: trace.count }, (_, index) => ({
        checks: ciOn(`car-${index}`, "green"),
        headSha: `car-${index}`,
        labels: ["train"],
        number: index + 1,
        operatorReviewed: true,
        owner: `author-${index}`,
        upToDate: true,
      }));

      yield* post({ at: T0, candidates, main: "main-a", type: "candidates" });
      yield* post({ at: T0 + 1, type: "depart" });
      const riding = yield* readTrain(train);

      if (trace.phase !== "building") {
        yield* post({
          at: T0 + 2,
          buildId: riding.context.build?.id ?? 0,
          conflicted: [],
          head: "built-a",
          merged: candidates.map((car) => car.number),
          type: "built",
        });
        yield* post({ at: T0 + 3, pr: 90, type: "prOpened" });
      }

      if (["awaitingGo", "merging"].includes(trace.phase)) {
        yield* post({
          at: T0 + 4,
          checks: ciOn("built-a", "green"),
          head: "built-a",
          type: "checks",
        });
      }

      if (trace.phase === "merging") {
        yield* post({
          at: T0 + 5,
          by: "operator",
          head: "built-a",
          type: "go",
        });
      }

      const moved = trace.moved % trace.count;
      const before = yield* readTrain(train);

      const after = yield* post({
        actualHead: "changed-head",
        admittedHead: trace.stale ? "old-head" : `car-${moved}`,
        at: T0 + 6,
        pr: moved + 1,
        type: "carHeadMoved",
      });

      if (trace.stale) {
        expect({ ...after.context, sync: before.context.sync }).toEqual(
          before.context
        );
      } else if (trace.phase === "merging") {
        expect(stateName(after)).toBe("abandoned");
        expect(after.context.abandonedBecause).toContain(
          "merge already dispatched"
        );
      } else {
        expect(after.context.cars.map((car) => car.number)).toEqual(
          candidates
            .filter((car) => car.number !== moved + 1)
            .map((car) => car.number)
        );
        expect(stateName(after)).toBe(
          trace.count === 1 ? "abandoned" : "building"
        );

        const notification = after.context.intents.findLast(
          (intent) => intent.kind === "NotifyOwner"
        );

        expect(notification).toMatchObject({
          car: { number: moved + 1 },
          reason: "head-moved",
        });

        if (notification?.kind === "NotifyOwner") {
          expect(notification.excerpt).toContain(`car-${moved}`);
          expect(notification.excerpt).toContain("changed-head");
          expect(renderNotification(notification, plain)).toContain(
            ": head moved."
          );
        }

        if (trace.count > 1) {
          const survivors = after.context.cars.map((car) => car.number);

          const staleBuild = yield* post({
            at: T0 + 7,
            buildId: before.context.build?.id ?? 0,
            conflicted: [],
            head: "stale-built",
            merged: candidates.map((car) => car.number),
            type: "built",
          });

          expect(stateName(staleBuild)).toBe("building");
          yield* post({
            at: T0 + 8,
            buildId: after.context.build?.id ?? 0,
            conflicted: [],
            head: "rebuilt-a",
            merged: survivors,
            type: "built",
          });
          yield* post({ at: T0 + 9, pr: 90, type: "prOpened" });
          yield* post({
            at: T0 + 10,
            checks: ciOn("rebuilt-a", "green"),
            head: "rebuilt-a",
            type: "checks",
          });
          yield* post({
            at: T0 + 11,
            by: "operator",
            head: "rebuilt-a",
            type: "go",
          });

          const landed = yield* post({
            at: T0 + 12,
            head: "rebuilt-a",
            mergeSha: "merged-a",
            type: "merged",
          });

          expect(stateName(landed)).toBe("landed");
          expect(
            metrics([landed.context.facts], []).rebuildsByCause["head-moved"]
          ).toBe(1);
          expect(
            landed.context.facts.findLast((fact) => fact.kind === "merged")
          ).toMatchObject({ cars: survivors });
        }
      }
    })
);
