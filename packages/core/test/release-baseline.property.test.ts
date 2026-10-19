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
import { jsonSnapshot } from "./json-snapshot.js";
import { releaseHappy, releaseInput } from "./release-fixtures.js";

const generated = {
  check: Arbitrary.schema(Schema.NonEmptyString),
  elapsed: Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 }))
  ),
  onFail: Arbitrary.schema(Schema.Literals(["restore", "escalate"])),
  timeout: Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
  ),
};

const inspect = Effect.fn("Test.Release.baseline")(function* inspect(
  check: string,
  onFail: "restore" | "escalate",
  timeout: number,
  baseline: "pass" | "fail" | "unknown" | "missing",
  outcome: "fail" | "breach" | "pass" | "unknown",
  elapsed: number
) {
  const fired = yield* stepRelease(
    yield* openRelease({
      ...releaseInput,
      checks: [{ name: check, onFail }],
      observationTimeoutMs: timeout,
    }),
    releaseHappy.slice(0, 3)
  );

  const events: readonly ReleaseEvent[] = [
    ...(baseline === "missing"
      ? []
      : [
          {
            at: 103,
            check,
            outcome: baseline,
            type: "baselined",
          } satisfies ReleaseEvent,
        ]),
    { at: 104, type: "deployed" },
    { at: 104 + elapsed, check, outcome, type: "observed" },
  ];

  const persisted = yield* stepRelease(jsonSnapshot(fired), events);

  return viewRelease(yield* readRelease(jsonSnapshot(persisted)));
});

describe("release pre-deploy baselines", () => {
  it.effect.prop(
    "baselines belong to their declared check and pre-deploy lifecycle across snapshot restores",
    {
      checks: Arbitrary.array(
        Arbitrary.schema(
          Schema.Struct({
            baseline: Schema.Literals(["pass", "fail", "unknown", "missing"]),
            onFail: Schema.Literals(["restore", "escalate"]),
          })
        ),
        { maxLength: 8, minLength: 1 }
      ),
    },
    ({ checks }) =>
      Effect.gen(function* isolatedBaselines() {
        const named = checks.map((check, index) => ({
          ...check,
          name: `check-${index}`,
        }));

        const armed = yield* stepRelease(
          yield* openRelease({
            ...releaseInput,
            checks: [{ name: "first", onFail: "restore" }, ...named],
          }),
          releaseHappy.slice(0, 2)
        );

        const fired = yield* stepRelease(jsonSnapshot(armed), [
          { at: 102, check: "first", outcome: "pass", type: "baselined" },
          { at: 103, by: "operator", type: "fire" },
          { at: 102, check: "first", outcome: "pass", type: "baselined" },
          { at: 103, check: "unlisted", outcome: "pass", type: "baselined" },
          ...named.flatMap((check): readonly ReleaseEvent[] =>
            check.baseline === "missing"
              ? []
              : [
                  {
                    at: 103,
                    check: check.name,
                    outcome: check.baseline,
                    type: "baselined",
                  },
                ]
          ),
        ]);

        const deployed = yield* stepRelease(jsonSnapshot(fired), [
          { at: 104, type: "deployed" },
          { at: 104, check: "first", outcome: "pass", type: "baselined" },
          ...named.map((check): ReleaseEvent => ({
            at: 104,
            check: check.name,
            outcome: "pass",
            type: "baselined",
          })),
        ]);

        const snapshot = yield* readRelease(jsonSnapshot(deployed));
        expect(snapshot.context.baselines).toEqual(
          Object.fromEntries(
            named
              .filter((check) => check.baseline !== "missing")
              .map((check) => [check.name, check.baseline])
          )
        );
        expect(
          snapshot.context.facts.filter(
            (fact) => "kind" in fact && fact.kind === "baseline"
          )
        ).toHaveLength(
          named.filter((check) => check.baseline !== "missing").length
        );
        expect(
          snapshot.context.intents.filter(
            (intent) => intent.kind === "Baseline"
          )
        ).toHaveLength(1);

        for (const check of [
          { baseline: "missing", name: "first", onFail: "restore" },
          ...named,
        ]) {
          const persisted = yield* stepRelease(jsonSnapshot(deployed), [
            { at: 105, check: check.name, outcome: "fail", type: "observed" },
          ]);

          const view = viewRelease(yield* readRelease(persisted));

          expect(view.facts.at(-1)?.cause).toBe(
            check.baseline === "pass"
              ? "observationFailed"
              : "observationPreexisting"
          );
          expect(view.state).toBe(
            check.baseline === "pass" && check.onFail === "restore"
              ? "restoring"
              : "escalated"
          );
        }
      })
  );

  it.effect.prop(
    "a passing baseline permits failure policy and precedes deploy",
    generated,
    ({ check, elapsed, timeout }) =>
      Effect.gen(function* passed() {
        for (const onFail of ["restore", "escalate"] satisfies readonly (
          | "restore"
          | "escalate"
        )[]) {
          const view = yield* inspect(
            check,
            onFail,
            timeout,
            "pass",
            "fail",
            elapsed
          );

          expect(view.intents.map((intent) => intent.kind).slice(0, 4)).toEqual(
            ["PlanRelease", "RequestReview", "Baseline", "Deploy"]
          );
          expect(view.facts).toContainEqual(
            expect.objectContaining({
              check,
              kind: "baseline",
              outcome: "pass",
            })
          );
          expect(view.state).toBe(
            onFail === "restore" ? "restoring" : "escalated"
          );
          expect(view.facts.at(-1)?.cause).toBe("observationFailed");
          expect(
            view.intents.filter((intent) => intent.kind === "Restore")
          ).toHaveLength(onFail === "restore" ? 1 : 0);
        }
      })
  );

  it.effect.prop(
    "a non-passing or missing baseline escalates a pre-existing failure, never restores",
    generated,
    ({ check, elapsed, onFail, timeout }) =>
      Effect.gen(function* preexisting() {
        for (const baseline of [
          "fail",
          "unknown",
          "missing",
        ] satisfies readonly ("fail" | "unknown" | "missing")[]) {
          const view = yield* inspect(
            check,
            onFail,
            timeout,
            baseline,
            "fail",
            elapsed
          );

          expect(view.state).toBe("escalated");
          expect(view.intents.some((intent) => intent.kind === "Restore")).toBe(
            false
          );
          expect(view.intents.at(-1)).toMatchObject({
            cause: "observationPreexisting",
            check,
            kind: "NotifyOwner",
          });
          expect(view.facts.at(-1)?.cause).toBe("observationPreexisting");
        }
      })
  );

  it.effect.prop(
    "breaches restore and expiry still escalates for every baseline",
    generated,
    ({ check, elapsed, onFail, timeout }) =>
      Effect.gen(function* unchanged() {
        for (const baseline of [
          "pass",
          "fail",
          "unknown",
          "missing",
        ] satisfies readonly ("pass" | "fail" | "unknown" | "missing")[]) {
          const breach = yield* inspect(
            check,
            onFail,
            timeout,
            baseline,
            "breach",
            elapsed
          );

          expect(breach.state).toBe("restoring");
          expect(breach.facts.at(-1)?.cause).toBe("observationBreach");

          for (const outcome of ["pass", "unknown"] satisfies readonly (
            | "pass"
            | "unknown"
          )[]) {
            const expired = yield* inspect(
              check,
              onFail,
              timeout,
              baseline,
              outcome,
              timeout + elapsed
            );

            expect(expired.state).toBe("escalated");
            expect(expired.facts.at(-1)?.cause).toBe("observationExpired");
            expect(
              expired.intents.some((intent) => intent.kind === "Restore")
            ).toBe(false);
          }
        }
      })
  );
});
