import { describe, expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  ReleaseExpectationSchema,
  ReleaseInputSchema,
  ReleaseIntentSchema,
  ReleaseViolationSchema,
} from "../src/release-domain.js";
import type { ReleaseExpectation, ReleaseRow } from "../src/release-domain.js";
import {
  openRelease,
  readRelease,
  stepRelease,
  viewRelease,
} from "../src/release-host.js";
import { checkReleaseExpectation } from "../src/release-policy.js";
import { releaseInput } from "./release-fixtures.js";

const count = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 12, minimum: 1 }))
);

const value = Arbitrary.schema(Schema.String);

const node = (index: number): ReleaseRow => ({
  action: "update",
  attributes: { cohort: "blue" },
  id: `node-${index}`,
  kind: "node",
});

const noop = (index: number): ReleaseRow => ({
  action: "noop",
  id: `unchanged-${index}`,
  kind: "node",
});

const held = Effect.fn("Test.Release.held")(function* held(
  plan: readonly ReleaseRow[],
  expectation: ReleaseExpectation
) {
  const persisted = yield* stepRelease(
    yield* openRelease({ ...releaseInput, expectation }),
    [{ at: 101, rows: plan, type: "planned" }]
  );

  const snapshot = yield* readRelease(persisted);
  const view = viewRelease(snapshot);
  expect(view.state).toBe("held");
  expect(view.intents.map((intent) => intent.kind)).toEqual(["PlanRelease"]);
  expect(view.facts.at(-1)?.offending).toEqual(view.offending);
  expect(view.offending.every(Schema.is(ReleaseViolationSchema))).toBe(true);

  return view;
});

describe("release expectation contracts", () => {
  it.effect.prop(
    "an empty plan holds unless explicitly permitted, independently of allowed matchers",
    { n: count },
    ({ n }) =>
      Effect.gen(function* emptyPlan() {
        const expectation = {
          allowed: Array.from({ length: n }, (_, index) => ({
            id: `node-${index}`,
          })),
          stop: [],
        };

        const view = yield* held([], expectation);
        expect(view.offending).toEqual([{ reason: "requiredMissing" }]);
        expect(
          checkReleaseExpectation([], { ...expectation, allowEmpty: true })
        ).toEqual([]);
        expect(
          checkReleaseExpectation([], {
            ...expectation,
            allowEmpty: true,
            required: [{ match: { kind: "node" } }],
          })
        ).toEqual([{ matcher: { kind: "node" }, reason: "requiredMissing" }]);
      })
  );

  it.effect.prop(
    "removing one required row holds with requiredMissing and no invented row",
    { n: count },
    ({ n }) =>
      Effect.gen(function* requiredMissing() {
        const plan = Array.from({ length: n }, (_, index) => node(index));

        const match = {
          action: "update",
          attributes: { cohort: "blue" },
          kind: "node",
        };

        const expectation = {
          allowed: [match],
          required: [{ match, max: n, min: n }],
          stop: [],
        };

        expect(checkReleaseExpectation(plan, expectation)).toEqual([]);

        const complete = yield* stepRelease(
          yield* openRelease({ ...releaseInput, expectation }),
          [{ at: 101, rows: plan, type: "planned" }]
        );

        expect((yield* readRelease(complete)).value).toBe("review");
        const view = yield* held(plan.slice(0, -1), expectation);
        expect(view.offending).toContainEqual({
          matcher: match,
          reason: "requiredMissing",
        });
        expect(view.offending.every((violation) => !("row" in violation))).toBe(
          true
        );
      })
  );

  it.effect.prop(
    "adding one extra noop beyond max holds with countOutOfRange",
    { n: count },
    ({ n }) =>
      Effect.gen(function* maximumCount() {
        const plan = [
          node(0),
          ...Array.from({ length: n }, (_, index) => noop(index)),
        ];

        const match = { action: "noop" };

        const expectation = {
          allowed: [{ kind: "node" }],
          required: [{ match, max: n, min: 0 }],
          stop: [],
        };

        expect(checkReleaseExpectation(plan, expectation)).toEqual([]);
        const view = yield* held([...plan, noop(n)], expectation);
        expect(view.offending).toEqual([
          { matcher: match, reason: "countOutOfRange" },
        ]);
      })
  );

  it.effect.prop(
    "attribute mismatch or a missing attribute counts as unmatched",
    { attribute: value },
    ({ attribute }) =>
      Effect.gen(function* attributeMatch() {
        const matcher = {
          attributes: { from: attribute, to: `${attribute}-next` },
          kind: "binding",
        };

        const valid = {
          action: "update",
          attributes: {
            from: attribute,
            to: `${attribute}-next`,
            value: "extra attribute",
          },
          id: "binding-a",
          kind: "binding",
        };

        const expectation = { allowed: [matcher], stop: [] };
        expect(checkReleaseExpectation([valid], expectation)).toEqual([]);

        for (const attributes of [
          { from: `${attribute}-changed`, to: `${attribute}-next` },
          { from: attribute },
        ]) {
          const row = { ...valid, attributes };
          const view = yield* held([row], expectation);
          expect(view.offending).toEqual([{ reason: "unmatched", row }]);
        }

        const absent = { action: valid.action, id: valid.id, kind: valid.kind };
        const view = yield* held([absent], expectation);
        expect(view.offending).toEqual([{ reason: "unmatched", row: absent }]);
      })
  );

  it.prop(
    "required defaults to one, zero bounds are explicit, and required does not allow rows",
    { attribute: value },
    ({ attribute }) => {
      const row = {
        action: "update",
        attributes: { value: attribute },
        id: "tag-a",
        kind: "tag",
      };

      const match = { attributes: { value: attribute }, kind: "tag" };
      const expectation = { allowed: [match], required: [{ match }], stop: [] };
      expect(checkReleaseExpectation([row, row], expectation)).toEqual([]);
      expect(checkReleaseExpectation([node(0)], expectation)).toContainEqual({
        matcher: match,
        reason: "requiredMissing",
      });
      expect(
        checkReleaseExpectation([row], { ...expectation, allowed: [] })
      ).toEqual([{ reason: "unmatched", row }]);
      expect(
        checkReleaseExpectation([row], {
          ...expectation,
          required: [{ match, max: 0, min: 0 }],
        })
      ).toEqual([{ matcher: match, reason: "countOutOfRange" }]);
      expect(
        checkReleaseExpectation([row], { ...expectation, stop: [match] })
      ).toEqual([{ matcher: match, reason: "stop", row }]);
    }
  );

  it.effect.prop(
    "schema rejects invalid cardinality bounds without weakening the checker",
    { n: count },
    ({ n }) =>
      Effect.gen(function* bounds() {
        for (const required of [
          { match: {}, max: n - 1, min: n },
          { match: {}, min: -n },
          { match: {}, max: -n },
          { match: {}, min: n + 0.5 },
          { match: {}, max: n + 0.5 },
          { match: {}, max: 0 },
        ]) {
          const result = yield* Schema.decodeUnknownEffect(
            ReleaseExpectationSchema
          )({ allowed: [{}], required: [required], stop: [] }).pipe(
            Effect.result
          );

          expect(Result.isFailure(result)).toBe(true);
        }

        const valid = yield* Schema.decodeUnknownEffect(
          ReleaseExpectationSchema
        )({
          allowed: [{}],
          required: [{ match: {}, max: 0, min: 0 }],
          stop: [],
        });

        expect(valid.required).toHaveLength(1);
      })
  );

  it.effect(
    "input and Observe intent reject empty observation checks at the boundary",
    () =>
      Effect.gen(function* observationChecks() {
        const input = yield* Schema.decodeUnknownEffect(ReleaseInputSchema)({
          ...releaseInput,
          checks: [],
        }).pipe(Effect.result);

        expect(Result.isFailure(input)).toBe(true);

        const intent = yield* Schema.decodeUnknownEffect(ReleaseIntentSchema)({
          at: 101,
          checks: [],
          deadlineAt: 201,
          id: "synthetic/4",
          kind: "Observe",
        }).pipe(Effect.result);

        expect(Result.isFailure(intent)).toBe(true);

        const accepted =
          yield* Schema.decodeUnknownEffect(ReleaseInputSchema)(releaseInput);

        expect(accepted.checks.length).toBeGreaterThan(0);
      })
  );
});
