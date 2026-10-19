import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { ReleaseEvent } from "../src/release-domain.js";
import {
  openRelease,
  readRelease,
  stepRelease,
  viewRelease,
} from "../src/release-host.js";
import { checkReleaseExpectation } from "../src/release-policy.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { releaseHappy, releaseInput } from "./release-fixtures.js";

const planEvent: ReleaseEvent = {
  at: 101,
  rows: [{ action: "update", id: "resource-a", kind: "resource" }],
  type: "planned",
};

const rows = Arbitrary.array(
  Arbitrary.schema(
    Schema.Struct({
      action: Schema.Literal("update"),
      id: Schema.NonEmptyString,
      kind: Schema.Literals(["resource", "computed", "deferred"]),
    })
  ),
  { maxLength: 30 }
);

const steps = Arbitrary.array(
  Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 0 }))
  ),
  { maxLength: 40 }
);

const eventOf = (n: number, at: number): ReleaseEvent => {
  switch (n) {
    case 0: {
      return { at, rows: planEvent.rows, type: "planned" };
    }

    case 1: {
      return { at, by: "reviewer", type: "reviewed", verdict: "approve" };
    }

    case 2: {
      return { at, by: "operator", type: "fire" };
    }

    case 3: {
      return { at, type: "deployed" };
    }

    case 4: {
      return { at, check: "availability", outcome: "fail", type: "observed" };
    }

    case 5: {
      return { at, check: "integrity", outcome: "pass", type: "observed" };
    }

    case 6: {
      return { at, type: "restored" };
    }

    case 7: {
      return { at, type: "reviewUnavailable" };
    }

    default: {
      return { at, type: "tick" };
    }
  }
};

describe("release invariants over synthetic plans and traces", () => {
  it.effect.prop(
    "a stop row always holds even when allowed",
    { plan: rows },
    ({ plan }) =>
      Effect.gen(function* stopAlwaysHolds() {
        const stop = { action: "delete", id: "extra", kind: "resource" };

        const input = {
          ...releaseInput,
          expectation: { allowed: [{}], stop: [{ action: "delete" }] },
        };

        const persisted = yield* stepRelease(yield* openRelease(input), [
          { at: 101, rows: [...plan, stop], type: "planned" },
        ]);

        const view = viewRelease(yield* readRelease(persisted));
        expect(view.state).toBe("held");
        expect(view.offending).toContainEqual({
          matcher: { action: "delete" },
          reason: "stop",
          row: stop,
        });
        expect(view.intents.map((intent) => intent.kind)).toEqual([
          "PlanRelease",
        ]);
      })
  );

  it.effect.prop("an unmatched row always holds", { plan: rows }, ({ plan }) =>
    Effect.gen(function* unmatchedAlwaysHolds() {
      const row = { action: "update", id: "extra", kind: "unrecognized" };

      const persisted = yield* stepRelease(yield* openRelease(releaseInput), [
        { at: 101, rows: [...plan, row], type: "planned" },
      ]);

      expect(
        viewRelease(yield* readRelease(persisted)).offending
      ).toContainEqual({ reason: "unmatched", row });
      expect((yield* readRelease(persisted)).value).toBe("held");
    })
  );

  it.effect.prop(
    "only fire reaches fired, review cannot be skipped, deployment is at most once across JSON restores",
    { generated: steps },
    ({ generated }) =>
      Effect.gen(function* trace() {
        let persisted = yield* openRelease(releaseInput);

        for (const [index, n] of generated.entries()) {
          const before = yield* readRelease(persisted);

          if (before.status !== "active") {
            break;
          }

          const event = eventOf(n, 101 + index);
          persisted = yield* stepRelease(jsonSnapshot(persisted), [event]);
          const after = yield* readRelease(persisted);

          const deploys = after.context.intents.filter(
            (intent) => intent.kind === "Deploy"
          );

          expect(deploys.length).toBeLessThanOrEqual(1);

          if (after.matches("fired") && !before.matches("fired")) {
            expect(event.type).toBe("fire");
            expect(before.value).toBe("armed");
          }

          if (deploys.length > 0) {
            expect(
              after.context.facts.some((fact) => fact.state === "review")
            ).toBe(true);
            expect(
              after.context.facts.some(
                (fact) => fact.cause === "reviewed" && fact.by === "reviewer"
              )
            ).toBe(true);
          }
        }
      })
  );

  it.effect.prop(
    "armed does not fire from non-fire events",
    { generated: steps },
    ({ generated }) =>
      Effect.gen(function* onlyFire() {
        let persisted = yield* stepRelease(
          yield* openRelease(releaseInput),
          releaseHappy.slice(0, 2)
        );

        for (const [index, n] of generated.entries()) {
          const event = eventOf(n, 103 + index);

          if (event.type === "fire") {
            continue;
          }

          persisted = yield* stepRelease(persisted, [event]);
          expect((yield* readRelease(persisted)).value).toBe("armed");
        }
      })
  );

  it.effect.prop(
    "a failed observation with a passing baseline starts one restore",
    { check: Arbitrary.schema(Schema.Literals(["availability", "integrity"])) },
    ({ check }) =>
      Effect.gen(function* failedObservation() {
        const persisted = yield* stepRelease(yield* openRelease(releaseInput), [
          ...releaseHappy.slice(0, 3),
          { at: 103, check, outcome: "pass", type: "baselined" },
          { at: 104, type: "deployed" },
          { at: 105, check, outcome: "fail", type: "observed" },
        ]);

        const view = viewRelease(yield* readRelease(persisted));
        expect(view.state).toBe("restoring");
        expect(
          view.intents.filter((intent) => intent.kind === "Restore")
        ).toEqual([
          {
            at: 105,
            id: "release-synthetic/6",
            kind: "Restore",
            to: "commit-before",
          },
        ]);
      })
  );

  it.effect(
    "runway and blackout are checked at fire time, including boundaries",
    () =>
      Effect.gen(function* runway() {
        for (const input of [
          { ...releaseInput, windowEndsAt: 202 },
          { ...releaseInput, blackoutUntil: 104 },
        ]) {
          const armed = yield* stepRelease(
            yield* openRelease(input),
            releaseHappy.slice(0, 2)
          );

          const denied = yield* stepRelease(armed, [
            { at: 103, by: "operator", type: "fire" },
          ]);

          expect((yield* readRelease(denied)).value).toBe("armed");
        }

        const exact = yield* stepRelease(
          yield* openRelease({
            ...releaseInput,
            blackoutUntil: 103,
            windowEndsAt: 203,
          }),
          releaseHappy.slice(0, 3)
        );

        expect((yield* readRelease(exact)).value).toBe("fired");
      })
  );

  it.effect("absence never approves and review hold cannot be overridden", () =>
    Effect.gen(function* review() {
      for (const event of [
        { at: 102, type: "reviewUnavailable" },
        { at: 102, by: "reviewer", type: "reviewed", verdict: "hold" },
      ] satisfies readonly ReleaseEvent[]) {
        const persisted = yield* stepRelease(yield* openRelease(releaseInput), [
          planEvent,
          event,
          { at: 103, by: "operator", type: "fire" },
        ]);

        expect((yield* readRelease(persisted)).value).toBe("held");
      }

      const configured = yield* stepRelease(
        yield* openRelease({ ...releaseInput, allowAbsentReview: true }),
        [planEvent, { at: 102, type: "reviewUnavailable" }]
      );

      const snapshot = yield* readRelease(configured);
      expect(snapshot.value).toBe("armed");
      expect(snapshot.context.facts.at(-1)?.cause).toBe("reviewUnavailable");
    })
  );

  it.effect(
    "missing and unknown observations escalate, failed restore holds, stale events cannot buy runway",
    () =>
      Effect.gen(function* deadlines() {
        let persisted = yield* stepRelease(
          yield* openRelease(releaseInput),
          releaseHappy.slice(0, 4)
        );

        persisted = yield* stepRelease(persisted, [
          {
            at: 105,
            check: "availability",
            outcome: "unknown",
            type: "observed",
          },
          { at: 204, type: "tick" },
        ]);
        expect((yield* readRelease(persisted)).value).toBe("escalated");
        persisted = yield* stepRelease(yield* openRelease(releaseInput), [
          ...releaseHappy.slice(0, 3),
          {
            at: 104,
            operation: "Deploy",
            reason: "deployment failed",
            type: "failed",
          },
        ]);
        expect((yield* readRelease(persisted)).value).toBe("restoring");
        persisted = yield* stepRelease(persisted, [
          {
            at: 205,
            operation: "Restore",
            reason: "synthetic failure",
            type: "failed",
          },
        ]);
        expect((yield* readRelease(persisted)).value).toBe("held");

        const armed = yield* stepRelease(
          yield* openRelease(releaseInput),
          releaseHappy.slice(0, 2)
        );

        const stale = yield* stepRelease(armed, [
          { at: 200, blackoutUntil: 0, type: "window", windowEndsAt: 201 },
          { at: 103, by: "operator", type: "fire" },
        ]);

        expect((yield* readRelease(stale)).value).toBe("armed");
      })
  );

  it.effect(
    "all checks pass accepts health but terminal snapshots cannot be fired again",
    () =>
      Effect.gen(function* accepted() {
        const persisted = yield* stepRelease(
          yield* openRelease(releaseInput),
          releaseHappy
        );

        const view = viewRelease(yield* readRelease(jsonSnapshot(persisted)));
        expect(view.state).toBe("accepted");
        expect(view.facts.map((fact) => fact.state)).toEqual([
          "planned",
          "expectationCheck",
          "review",
          "armed",
          "fired",
          "observing",
          "observing",
          "accepted",
        ]);
        expect(
          (yield* Effect.flip(
            stepRelease(persisted, [{ at: 200, by: "operator", type: "fire" }])
          ))._tag
        ).toBe("ReleaseFinished");
      })
  );

  it.prop(
    "matchers are conjunctions, allowed is a union, and stop wins",
    { plan: rows },
    ({ plan }) => {
      expect(
        checkReleaseExpectation(plan, {
          ...releaseInput.expectation,
          allowEmpty: true,
        })
      ).toEqual([]);
      expect(
        checkReleaseExpectation(plan, {
          allowEmpty: true,
          allowed: [],
          stop: [],
        })
      ).toEqual(plan.map((row) => ({ reason: "unmatched", row })));
      expect(
        checkReleaseExpectation(plan, {
          allowEmpty: true,
          allowed: [{}],
          stop: [{}],
        })
      ).toEqual(plan.map((row) => ({ matcher: {}, reason: "stop", row })));
    }
  );
});
