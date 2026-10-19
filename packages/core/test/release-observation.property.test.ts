import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { ReleaseEvent, ReleaseInput } from "../src/release-domain.js";
import {
  openRelease,
  readRelease,
  stepRelease,
  viewRelease,
} from "../src/release-host.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { releaseHappy, releaseInput } from "./release-fixtures.js";

const declarations = Arbitrary.array(
  Arbitrary.schema(
    Schema.Struct({
      onFail: Schema.Literals(["restore", "escalate"]),
      outcome: Schema.Literals(["pass", "fail", "unknown"]),
    })
  ),
  { maxLength: 8, minLength: 1 }
);

const checksOf = (
  generated: readonly { readonly onFail: "restore" | "escalate" }[]
): ReleaseInput["checks"] => [
  { name: "first", onFail: "escalate" },
  ...generated.map((check, index) => ({
    name: `check-${index}`,
    onFail: check.onFail,
  })),
];

const observing = Effect.fn("Test.Release.observing")(function* observing(
  checks: ReleaseInput["checks"]
) {
  return yield* stepRelease(yield* openRelease({ ...releaseInput, checks }), [
    ...releaseHappy.slice(0, 3),
    ...checks.map((check): ReleaseEvent => ({
      at: 103,
      check: check.name,
      outcome: "pass",
      type: "baselined",
    })),
    { at: 104, type: "deployed" },
  ]);
});

const inspect = Effect.fn("Test.Release.inspect")(function* inspect(
  checks: ReleaseInput["checks"],
  event: ReleaseEvent
) {
  const persisted = yield* stepRelease(jsonSnapshot(yield* observing(checks)), [
    event,
  ]);

  return viewRelease(yield* readRelease(jsonSnapshot(persisted)));
});

describe("release observation policy", () => {
  it.effect.prop(
    "failure policy takes precedence for arbitrary deadlines and report times",
    {
      check: Arbitrary.schema(Schema.NonEmptyString),
      deployedAt: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 1_000_000, minimum: 104 }))
      ),
      elapsed: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 1_000_000, minimum: 0 }))
      ),
      timeout: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 1_000_000, minimum: 1 }))
      ),
    },
    ({ check, deployedAt, elapsed, timeout }) =>
      Effect.gen(function* failurePrecedence() {
        const deadlineAt = deployedAt + timeout;

        for (const onFail of ["restore", "escalate"] satisfies readonly (
          | "restore"
          | "escalate"
        )[]) {
          const observingSnapshot = yield* stepRelease(
            yield* openRelease({
              ...releaseInput,
              checks: [{ name: check, onFail }],
              observationTimeoutMs: timeout,
            }),
            [
              ...releaseHappy.slice(0, 3),
              { at: 103, check, outcome: "pass", type: "baselined" },
              { at: deployedAt, type: "deployed" },
            ]
          );

          for (const at of [
            deployedAt + elapsed,
            deadlineAt,
            deadlineAt + elapsed,
          ]) {
            const persisted = yield* stepRelease(
              jsonSnapshot(observingSnapshot),
              [{ at, check, outcome: "fail", type: "observed" }]
            );

            const view = viewRelease(
              yield* readRelease(jsonSnapshot(persisted))
            );

            expect(view.facts.at(-1)?.cause).toBe("observationFailed");
            expect(view.state).toBe(
              onFail === "restore" ? "restoring" : "escalated"
            );
            expect(
              view.intents.filter((intent) => intent.kind === "Restore")
            ).toHaveLength(onFail === "restore" ? 1 : 0);

            if (onFail === "escalate") {
              expect(view.intents.at(-1)).toMatchObject({
                cause: "observationFailed",
                check,
                kind: "NotifyOwner",
              });
            }
          }
        }
      })
  );
  it.effect.prop(
    "unknown stays non-terminal and only passes count toward acceptance",
    { generated: declarations },
    ({ generated }) =>
      Effect.gen(function* unknowns() {
        const checks = checksOf(generated);
        let persisted = yield* observing(checks);

        for (const [index, check] of generated.entries()) {
          const outcome = check.outcome === "pass" ? "pass" : "unknown";
          persisted = yield* stepRelease(jsonSnapshot(persisted), [
            { at: 105, check: `check-${index}`, outcome, type: "observed" },
          ]);
          expect((yield* readRelease(persisted)).value).toBe("observing");
        }

        persisted = yield* stepRelease(persisted, [
          { at: 105, check: "first", outcome: "pass", type: "observed" },
        ]);
        const view = viewRelease(yield* readRelease(persisted));
        expect(view.state).toBe(
          generated.every((check) => check.outcome === "pass")
            ? "accepted"
            : "observing"
        );
        expect(
          view.intents.some(
            (intent) =>
              intent.kind === "Restore" || intent.kind === "NotifyOwner"
          )
        ).toBe(false);
      })
  );
  it.effect.prop(
    "escalate failures never restore and name the failing check",
    { generated: declarations },
    ({ generated }) =>
      Effect.gen(function* escalateFailure() {
        const checks = checksOf(generated);

        for (const check of checks) {
          const view = yield* inspect(
            [
              { ...check, onFail: "escalate" },
              ...checks.filter((other) => other.name !== check.name),
            ],
            { at: 105, check: check.name, outcome: "fail", type: "observed" }
          );

          expect(view.state).toBe("escalated");
          expect(view.intents.some((intent) => intent.kind === "Restore")).toBe(
            false
          );
          expect(view.intents.at(-1)).toMatchObject({
            cause: "observationFailed",
            check: check.name,
            kind: "NotifyOwner",
          });
          expect(view.target).toBe(releaseInput.target);
        }
      })
  );

  it.effect.prop(
    "restore failures always restore before the deadline",
    { generated: declarations },
    ({ generated }) =>
      Effect.gen(function* restoreFailure() {
        for (const check of checksOf(generated)) {
          const view = yield* inspect([{ ...check, onFail: "restore" }], {
            at: 105,
            check: check.name,
            outcome: "fail",
            type: "observed",
          });

          expect(view.state).toBe("restoring");
          expect(
            view.intents.filter((intent) => intent.kind === "Restore")
          ).toEqual([
            {
              at: 105,
              id: "release-synthetic/6",
              kind: "Restore",
              to: releaseInput.previousTarget,
            },
          ]);
        }
      })
  );

  it.effect.prop(
    "hard breaches restore regardless of policy or deadline",
    { generated: declarations, late: Arbitrary.schema(Schema.Boolean) },
    ({ generated, late }) =>
      Effect.gen(function* hardBreach() {
        const checks = checksOf(generated);

        for (const check of checks) {
          const view = yield* inspect(checks, {
            at: late ? 204 : 105,
            check: check.name,
            outcome: "breach",
            type: "observed",
          });

          expect(view.state).toBe("restoring");
          expect(
            view.intents.filter((intent) => intent.kind === "Restore")
          ).toHaveLength(1);
          expect(view.facts.at(-1)?.cause).toBe("observationBreach");
        }
      })
  );

  it.effect.prop(
    "expiry escalates, never restores, for ticks, passes and unknown observations",
    {
      delay: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 10_000, minimum: 0 }))
      ),
      generated: declarations,
    },
    ({ generated, delay }) =>
      Effect.gen(function* expiry() {
        const checks = checksOf(generated);
        const at = 204 + delay;

        const events: readonly ReleaseEvent[] = [
          { at, type: "tick" },
          ...generated.map((check, index): ReleaseEvent => ({
            at,
            check: `check-${index}`,
            outcome: check.outcome === "fail" ? "unknown" : check.outcome,
            type: "observed",
          })),
        ];

        for (const event of events) {
          const view = yield* inspect(checks, event);
          expect(view.state).toBe("escalated");
          expect(view.intents.some((intent) => intent.kind === "Restore")).toBe(
            false
          );
          expect(view.intents.at(-1)).toMatchObject({
            cause: "observationExpired",
            kind: "NotifyOwner",
          });
          expect(view.facts.at(-1)?.cause).toBe("observationExpired");
        }
      })
  );

  it.effect.prop(
    "acceptance requires every check to pass, in any reporting order",
    { generated: declarations, reverse: Arbitrary.schema(Schema.Boolean) },
    ({ generated, reverse }) =>
      Effect.gen(function* everyPass() {
        const checks = checksOf(generated);
        const order = reverse ? checks.toReversed() : checks;
        let persisted = yield* observing(checks);

        for (const [index, check] of order.entries()) {
          persisted = yield* stepRelease(jsonSnapshot(persisted), [
            { at: 105, check: check.name, outcome: "pass", type: "observed" },
          ]);
          expect((yield* readRelease(persisted)).value).toBe(
            index === order.length - 1 ? "accepted" : "observing"
          );
        }

        const missing = yield* stepRelease(
          yield* observing(checks),
          order.slice(1).map((check): ReleaseEvent => ({
            at: 105,
            check: check.name,
            outcome: "pass",
            type: "observed",
          }))
        );

        expect((yield* readRelease(missing)).value).toBe("observing");
      })
  );

  it.effect(
    "unknown and early ticks keep observing; passes accept in reverse order",
    () =>
      Effect.gen(function* nonterminal() {
        let persisted = yield* observing(releaseInput.checks);

        for (const event of [
          {
            at: 105,
            check: "availability",
            outcome: "unknown",
            type: "observed",
          },
          { at: 106, type: "tick" },
          { at: 107, check: "integrity", outcome: "pass", type: "observed" },
          { at: 108, check: "unlisted", outcome: "breach", type: "observed" },
        ] satisfies readonly ReleaseEvent[]) {
          persisted = yield* stepRelease(persisted, [event]);
          expect((yield* readRelease(persisted)).value).toBe("observing");
        }

        persisted = yield* stepRelease(persisted, [
          { at: 109, check: "availability", outcome: "pass", type: "observed" },
        ]);
        expect((yield* readRelease(persisted)).value).toBe("accepted");
      })
  );

  it.effect(
    "restore failure and breach enter restoring; restored completes recovery",
    () =>
      Effect.gen(function* recovery() {
        for (const outcome of ["fail", "breach"] satisfies readonly (
          | "fail"
          | "breach"
        )[]) {
          const persisted = yield* stepRelease(
            yield* observing(releaseInput.checks),
            [{ at: 105, check: "availability", outcome, type: "observed" }]
          );

          expect((yield* readRelease(persisted)).value).toBe("restoring");

          const restored = yield* stepRelease(jsonSnapshot(persisted), [
            { at: 106, type: "restored" },
          ]);

          expect((yield* readRelease(restored)).value).toBe("restored");
        }
      })
  );

  it.effect(
    "an escalate failure or expiry ends observation and clears the alarm",
    () =>
      Effect.gen(function* escalation() {
        for (const event of [
          { at: 105, check: "first", outcome: "fail", type: "observed" },
          { at: 204, check: "first", outcome: "pass", type: "observed" },
          { at: 204, type: "tick" },
        ] satisfies readonly ReleaseEvent[]) {
          const view = yield* inspect(
            [{ name: "first", onFail: "escalate" }],
            event
          );

          expect(view.state).toBe("escalated");
          expect(view.status).toBe("done");
          expect(view.alarmAt).toBeUndefined();
          expect(view.intents.some((intent) => intent.kind === "Restore")).toBe(
            false
          );
        }
      })
  );
});
