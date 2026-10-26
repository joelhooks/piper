import { expect, it } from "@effect/vitest";
import type { Candidate } from "@joelhooks/piper/domain";
import { openTrain, readTrain, stepTrain } from "@joelhooks/piper/host";
import { Effect, Layer, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  CarStillAdmitted,
  carAdmissionStatuses,
} from "../src/car-admission.js";
import type { CarAdmissionRequest } from "../src/car-admission.js";
import { drainTrain } from "../src/train-tasks.js";
import { runTrain } from "../src/train.js";
import { admission, direct, finish, fixture } from "./train-fixture.js";

const decisions = Arbitrary.schema(
  Schema.Literals(["Admitted", "Revoked", "Unknown"])
);

const paths = Arbitrary.schema(Schema.Boolean);

const groupSize = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 6, minimum: 2 }))
);

it.effect.prop(
  "checks every car, including a later revoke after unknown advice",
  { groupSize },
  ({ groupSize: count }) =>
    Effect.gen(function* groupRevocation() {
      const test = yield* fixture();

      const candidates = Array.from(
        { length: count },
        (_, index) =>
          ({
            checks: [
              {
                conclusion: "success",
                headSha: `car-${index}`,
                name: "unit",
                status: "completed",
              },
            ],
            headSha: `car-${index}`,
            labels: ["queue"],
            number: index + 1,
            operatorReviewed: true,
            owner: `author-${index}`,
            upToDate: true,
          }) satisfies Candidate
      );

      const initial = yield* openTrain({ ...admission.input, maxCars: 6 });

      const train = yield* stepTrain(initial, [
        { at: 0, candidates, main: "base-a", type: "candidates" },
        { at: 1, type: "depart" },
        {
          at: 2,
          buildId: 1,
          conflicted: [],
          head: "built-a",
          merged: candidates.map((car) => car.number),
          type: "built",
        },
        { at: 3, pr: 90, type: "prOpened" },
        {
          at: 4,
          checks: [
            {
              conclusion: "success",
              headSha: "built-a",
              name: "unit",
              status: "completed",
            },
          ],
          head: "built-a",
          type: "checks",
        },
        { at: 5, by: "operator", head: "built-a", type: "go" },
      ]);

      const snapshot = yield* readTrain(train);
      const checked: number[] = [];

      const port = Layer.succeed(CarStillAdmitted, {
        check: ({ car }) =>
          Effect.sync(() => {
            checked.push(car.number);

            return car.number === count
              ? carAdmissionStatuses.Revoked({
                  reason: "owner withdrew approval",
                })
              : carAdmissionStatuses.Unknown({ reason: "no advice" });
          }),
      });

      const result = yield* drainTrain({
        admission,
        seen: snapshot.context.intents
          .filter((intent) => intent.kind !== "Merge")
          .map((intent) => intent.id),
        stop: undefined,
        train,
        writes: 0,
      }).pipe(Effect.provide(Layer.merge(test.layer, port)));

      expect(checked).toEqual(candidates.map((car) => car.number));
      expect(result.context.stop?._tag).toBe("GoRevoked");
      expect(result.context.stop?.stop).toContain(`car #${count}`);
      expect(result.context.writes).toBe(0);
      expect(test.github.writes).toEqual([]);
    })
);

it.effect.prop(
  "rechecks GO after ready and only a positive revoke prevents Merge",
  { decisions, paths },
  ({ decisions: decision, paths: directPath }) =>
    Effect.gen(function* revokedGo() {
      const test = yield* fixture();
      const requests: CarAdmissionRequest[] = [];

      const port = Layer.succeed(CarStillAdmitted, {
        check: Effect.fn("CarAdmissionTest.check")(function* check(
          request: CarAdmissionRequest
        ) {
          requests.push(request);
          expect(
            (yield* test.sink.lines).some((line) =>
              line.includes('"done":"MarkReady"')
            )
          ).toBe(true);

          if (decision === "Revoked") {
            return carAdmissionStatuses.Revoked({
              reason: "owner withdrew approval",
            });
          }

          return decision === "Unknown"
            ? carAdmissionStatuses.Unknown({
                reason: "approval store unavailable",
              })
            : carAdmissionStatuses.Admitted();
        }),
      });

      const result = yield* finish(
        runTrain(directPath ? direct : admission).pipe(
          Effect.provide(Layer.merge(test.layer, port))
        )
      );

      expect(
        requests.map(({ car, repo, train }) => ({
          car: { headSha: car.headSha, number: car.number },
          repo,
          train,
        }))
      ).toEqual([
        { car: admission.car, repo: admission.repo, train: admission.train },
      ]);

      const merges = test.github.writes.filter((write) =>
        write.path.endsWith("/merge")
      );

      if (decision === "Revoked") {
        expect(merges).toEqual([]);
        expect(result.stop?._tag).toBe("GoRevoked");
        expect(result.stop?.harm).toBe(
          "landing a car its owner no longer approves"
        );
        expect(result.stop?.stop).toContain("owner withdrew approval");
        expect(result.stop?.next).toBe(
          "get a new GO from the owner, then board the car again"
        );
      } else {
        expect(result.exit).toBe("landed");
        expect(merges).toHaveLength(1);

        if (decision === "Unknown") {
          expect(
            (yield* test.sink.lines).some((line) =>
              line.includes("approval store unavailable")
            )
          ).toBe(true);
        }
      }
    })
);
