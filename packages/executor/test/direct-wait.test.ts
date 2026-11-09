import { expect, it } from "@effect/vitest";
import { openTrain, stateName } from "@joelhooks/piper/host";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import type { RunnerContext } from "../src/train-tasks.js";
import { boardTrain, pollTrain } from "../src/train-tasks.js";
import { direct, fixture } from "./train-fixture.js";

for (const enabled of [false, true]) {
  it.effect(
    `a collecting train without an active wait stays tick-only with the rule ${enabled ? "enabled" : "absent"}`,
    () =>
      Effect.gen(function* defaultPoll() {
        const test = yield* fixture();

        test.github.controls.candidateChecks = [
          {
            conclusion: "failure",
            headSha: direct.car.headSha,
            name: "unit",
            status: "completed",
          },
        ];

        const admission = enabled
          ? {
              ...direct,
              input: { ...direct.input, directWaitChecks: ["gate"] },
            }
          : direct;

        const held = yield* boardTrain({
          admission,
          seen: [],
          stop: undefined,
          train: yield* openTrain(admission.input),
          writes: 0,
        }).pipe(Effect.provide(test.layer));

        expect(
          held.snapshot === undefined ? undefined : stateName(held.snapshot)
        ).toBe("collecting");
        test.github.controls.candidateChecks = [
          {
            conclusion: "success",
            headSha: direct.car.headSha,
            name: "unit",
            status: "completed",
          },
        ];

        const fiber = yield* pollTrain(held.context).pipe(
          Effect.provide(test.layer),
          Effect.forkChild
        );

        yield* TestClock.adjust(60_000);

        const polled = yield* Fiber.join(fiber);

        expect(
          polled.snapshot === undefined ? undefined : stateName(polled.snapshot)
        ).toBe("collecting");
        expect(polled.snapshot?.context.pool).toEqual(
          held.snapshot?.context.pool
        );
        expect(polled.snapshot?.context.facts).toEqual([]);
      })
  );
}

for (const completes of [true, false]) {
  it.effect(
    `polls fresh waited checks and ${completes ? "lands directly" : "boards at the bound"}`,
    () =>
      Effect.gen(function* waitingPoll() {
        const test = yield* fixture();

        const admission = {
          ...direct,
          input: {
            ...direct.input,
            ciTimeoutMs: 120_000,
            directWaitChecks: ["gate"],
          },
        };

        test.github.controls.candidateChecks = [
          {
            conclusion: "success",
            headSha: direct.car.headSha,
            name: "unit",
            status: "completed",
          },
          {
            conclusion: null,
            headSha: direct.car.headSha,
            name: "gate",
            status: "in_progress",
          },
        ];

        const context: RunnerContext = {
          admission,
          seen: [],
          stop: undefined,
          train: yield* openTrain(admission.input),
          writes: 0,
        };

        const held = yield* boardTrain(context).pipe(
          Effect.provide(test.layer)
        );

        expect(held.context.stop).toBeUndefined();
        expect(
          held.snapshot === undefined ? undefined : stateName(held.snapshot)
        ).toBe("collecting");
        expect(held.snapshot?.context.directWait?.since).toBeDefined();
        expect(test.github.writes).toEqual([]);

        const middleFiber = yield* pollTrain({
          ...held.context,
          admission: {
            ...admission,
            input: { ...admission.input, directWaitChecks: [] },
          },
        }).pipe(Effect.provide(test.layer), Effect.forkChild);

        yield* TestClock.adjust(60_000);

        const middle = yield* Fiber.join(middleFiber);

        expect(
          middle.snapshot === undefined ? undefined : stateName(middle.snapshot)
        ).toBe("collecting");
        expect(middle.snapshot?.context.directWait?.since).toBe(
          held.snapshot?.context.directWait?.since
        );
        expect(test.github.writes).toEqual([]);

        if (completes) {
          test.github.controls.candidateChecks = [
            {
              conclusion: "success",
              headSha: direct.car.headSha,
              name: "unit",
              status: "completed",
            },
            {
              conclusion: "success",
              headSha: direct.car.headSha,
              name: "gate",
              status: "completed",
            },
          ];
        }

        const fiber = yield* pollTrain(middle.context).pipe(
          Effect.provide(test.layer),
          Effect.forkChild
        );

        yield* TestClock.adjust(60_000);
        const polled = yield* Fiber.join(fiber);
        expect(polled.context.stop).toBeUndefined();
        expect(polled.snapshot?.context.facts).toContainEqual(
          expect.objectContaining({
            kind: "departed",
            path: completes ? "direct-land" : "lone-board",
          })
        );
        expect(polled.snapshot?.context.directWait).toBeUndefined();
      })
  );
}
