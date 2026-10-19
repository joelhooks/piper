import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  PostedReleaseEventSchema,
  ReleaseFactSchema,
  ReleaseInputSchema,
  toReleaseEvent,
} from "../src/release-domain.js";
import type {
  PostedReleaseEvent,
  ReleaseEvent,
  ReleaseInput,
} from "../src/release-domain.js";
import {
  openRelease,
  readRelease,
  stepRelease,
  viewRelease,
} from "../src/release-host.js";
import { jsonSnapshot } from "./json-snapshot.js";
import { releaseHappy, releaseInput } from "./release-fixtures.js";

const generated = Arbitrary.schema(
  Schema.Struct({
    at: Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 10 })),
    blackoutUntil: Schema.Int.check(
      Schema.isBetween({ maximum: 200_000, minimum: 0 })
    ),
    by: Schema.NonEmptyString,
    delay: Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 })),
    reason: Schema.NonEmptyString,
    windowEndsAt: Schema.Int.check(
      Schema.isBetween({ maximum: 200_000, minimum: 0 })
    ),
  })
);

const plan: ReleaseEvent = {
  at: 101,
  rows: [{ action: "update", id: "resource-a", kind: "resource" }],
  type: "planned",
};

const held = (input: ReleaseInput, at: number) =>
  Effect.gen(function* reviewHold() {
    return yield* stepRelease(yield* openRelease(input), [
      { ...plan, at: input.at },
      { at, by: "reviewer", type: "reviewed", verdict: "hold" },
    ]);
  });

describe("release review override authority", () => {
  it.effect.prop(
    "an authorized override resumes exactly like approval after a JSON restore",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* authorized() {
        const input = {
          ...releaseInput,
          at: sample.at,
          blackoutUntil: sample.blackoutUntil,
          overrideBy: sample.by,
          windowEndsAt: sample.windowEndsAt,
        };

        const at = sample.at + sample.delay;

        const event: ReleaseEvent = {
          at,
          by: sample.by,
          reason: sample.reason,
          type: "override",
        };

        const before = yield* held(input, sample.at);
        const resumed = yield* stepRelease(jsonSnapshot(before), [event]);

        const approved = yield* stepRelease(yield* openRelease(input), [
          { ...plan, at: sample.at },
          { at, by: "reviewer", type: "reviewed", verdict: "approve" },
        ]);

        const actual = viewRelease(yield* readRelease(jsonSnapshot(resumed)));
        const expected = viewRelease(yield* readRelease(approved));
        expect(actual.state).toBe(expected.state);
        expect(actual.intents).toEqual(expected.intents);
        expect(
          actual.facts.filter(
            (fact) => "kind" in fact && fact.kind === "override"
          )
        ).toEqual([
          expect.objectContaining({
            at,
            by: sample.by,
            kind: "override",
            reason: sample.reason,
          }),
        ]);
        expect(actual.status).toBe("active");
        expect(actual.rows).toEqual(expected.rows);
        expect(actual.facts.at(-1)).toEqual(
          yield* Schema.decodeUnknownEffect(ReleaseFactSchema)(
            actual.facts.at(-1)
          )
        );
        const fire: ReleaseEvent = { at, by: sample.by, type: "fire" };
        const overriddenFire = yield* stepRelease(resumed, [fire]);
        const approvedFire = yield* stepRelease(approved, [fire]);
        expect(viewRelease(yield* readRelease(overriddenFire)).intents).toEqual(
          viewRelease(yield* readRelease(approvedFire)).intents
        );
        const repeated = yield* stepRelease(resumed, [event]);
        expect(viewRelease(yield* readRelease(repeated))).toEqual(actual);
      })
  );

  it.effect.prop(
    "wrong identities and stale overrides cannot change a review hold",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* denied() {
        const input = { ...releaseInput, at: sample.at, overrideBy: sample.by };
        const before = yield* held(input, sample.at);
        const expected = viewRelease(yield* readRelease(before));
        expect(expected.state).toBe("reviewHeld");
        expect(expected.status).toBe("active");

        for (const event of [
          {
            at: sample.at + sample.delay,
            by: `${sample.by}-other`,
            reason: sample.reason,
            type: "override",
          },
          {
            at: sample.at - 1,
            by: sample.by,
            reason: sample.reason,
            type: "override",
          },
          {
            at: sample.at + sample.delay,
            by: sample.by,
            type: "reviewed",
            verdict: "approve",
          },
          { at: sample.at + sample.delay, by: sample.by, type: "fire" },
          {
            at: sample.at + sample.delay,
            blackoutUntil: 0,
            type: "window",
            windowEndsAt: 1_000_000,
          },
        ] satisfies readonly ReleaseEvent[]) {
          const after = yield* stepRelease(jsonSnapshot(before), [event]);
          expect(viewRelease(yield* readRelease(after))).toEqual(expected);
        }
      })
  );

  it.effect.prop(
    "a non-stale rejection finishes a review hold without an override fact",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* rejectReviewHold() {
        const input = { ...releaseInput, at: sample.at, overrideBy: sample.by };
        const before = yield* held(input, sample.at);
        const at = sample.at + sample.delay;

        const event: ReleaseEvent = {
          at,
          by: sample.by,
          reason: sample.reason,
          type: "reject",
        };

        const after = yield* stepRelease(jsonSnapshot(before), [event]);
        const view = viewRelease(yield* readRelease(jsonSnapshot(after)));
        expect(view.state).toBe("rejected");
        expect(view.status).toBe("done");
        expect(view.intents).toEqual(
          (yield* readRelease(before)).context.intents
        );
        expect(view.facts.at(-1)).toEqual({
          at,
          by: sample.by,
          cause: sample.reason,
          offending: [],
          state: "rejected",
        });
        expect(
          view.facts.filter(
            (fact) => "kind" in fact && fact.kind === "override"
          )
        ).toEqual([]);
        expect((yield* Effect.flip(stepRelease(after, [event])))._tag).toBe(
          "ReleaseFinished"
        );
      })
  );

  it.effect.prop(
    "no configured identity leaves review holds terminal",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* unconfigured() {
        const input = { ...releaseInput, at: sample.at };
        const before = yield* held(input, sample.at);
        const expected = viewRelease(yield* readRelease(jsonSnapshot(before)));
        expect(expected.state).toBe("held");
        expect(expected.status).toBe("done");

        const after = yield* stepRelease(yield* openRelease(input), [
          { ...plan, at: sample.at },
          { at: sample.at, by: "reviewer", type: "reviewed", verdict: "hold" },
          {
            at: sample.at + sample.delay,
            by: sample.by,
            reason: sample.reason,
            type: "override",
          },
        ]);

        expect(viewRelease(yield* readRelease(after))).toEqual(expected);
        expect((yield* Effect.flip(stepRelease(before, [])))._tag).toBe(
          "ReleaseFinished"
        );
      })
  );

  it.effect.prop(
    "non-review holds and rejection remain terminal with an override identity",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* terminal() {
        const input = { ...releaseInput, overrideBy: sample.by };
        const at = 107 + sample.at + sample.delay;

        const event: ReleaseEvent = {
          at,
          by: sample.by,
          reason: sample.reason,
          type: "override",
        };

        const prefixes: readonly (readonly ReleaseEvent[])[] = [
          [
            {
              at: 101,
              rows: [{ action: "delete", id: "resource-a", kind: "resource" }],
              type: "planned",
            },
          ],
          [{ at: 101, rows: [], type: "planned" }],
          [
            {
              at: 101,
              rows: [{ action: "update", id: "resource-a", kind: "unknown" }],
              type: "planned",
            },
          ],
          [plan, { at: 102, type: "reviewUnavailable" }],
          [
            {
              at: 101,
              operation: "PlanRelease",
              reason: "reviewed",
              type: "failed",
            },
          ],
          [{ at: 101, by: sample.by, reason: sample.reason, type: "reject" }],
          [
            ...releaseHappy.slice(0, 3),
            {
              at: 104,
              operation: "Deploy",
              reason: sample.reason,
              type: "failed",
            },
            {
              at: 105,
              operation: "Restore",
              reason: "reviewed",
              type: "failed",
            },
          ],
        ];

        for (const prefix of prefixes) {
          const before = yield* stepRelease(yield* openRelease(input), prefix);

          const expected = viewRelease(
            yield* readRelease(jsonSnapshot(before))
          );

          expect(expected.status).toBe("done");

          const after = yield* stepRelease(yield* openRelease(input), [
            ...prefix,
            event,
          ]);

          expect(viewRelease(yield* readRelease(after))).toEqual(expected);
          expect(
            (yield* Effect.flip(stepRelease(jsonSnapshot(before), [event])))
              ._tag
          ).toBe("ReleaseFinished");
        }
      })
  );

  it.effect.prop(
    "override is ignored in every non-held release phase",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* phases() {
        const input = { ...releaseInput, overrideBy: sample.by };

        const event: ReleaseEvent = {
          at: 107 + sample.at + sample.delay,
          by: sample.by,
          reason: sample.reason,
          type: "override",
        };

        const prefixes: readonly (readonly ReleaseEvent[])[] = [
          [],
          ...Array.from({ length: releaseHappy.length }, (_, index) =>
            releaseHappy.slice(0, index + 1)
          ),
          [
            ...releaseHappy.slice(0, 4),
            {
              at: 105,
              check: "availability",
              outcome: "fail",
              type: "observed",
            },
          ],
          [
            ...releaseHappy.slice(0, 4),
            {
              at: 105,
              check: "availability",
              outcome: "fail",
              type: "observed",
            },
            { at: 106, type: "restored" },
          ],
          [...releaseHappy.slice(0, 4), { at: 204, type: "tick" }],
        ];

        for (const prefix of prefixes) {
          const before = yield* stepRelease(yield* openRelease(input), prefix);

          const after = yield* stepRelease(yield* openRelease(input), [
            ...prefix,
            event,
          ]);

          expect(viewRelease(yield* readRelease(jsonSnapshot(after)))).toEqual(
            viewRelease(yield* readRelease(before))
          );
        }
      })
  );

  it.prop(
    "override input and posted event retain names and reject empty attribution",
    { generated },
    ({ generated: sample }) => {
      expect(
        Schema.decodeUnknownSync(ReleaseInputSchema)({
          ...releaseInput,
          overrideBy: sample.by,
        }).overrideBy
      ).toBe(sample.by);

      const posted = Schema.decodeSync(PostedReleaseEventSchema)(
        Data.taggedEnum<PostedReleaseEvent>().override({
          at: sample.at,
          by: sample.by,
          reason: sample.reason,
        })
      );

      expect(toReleaseEvent(posted)).toEqual({ ...posted, type: "override" });
      expect(() =>
        Schema.decodeUnknownSync(PostedReleaseEventSchema)({
          ...posted,
          reason: "",
        })
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(ReleaseInputSchema)({
          ...releaseInput,
          overrideBy: "",
        })
      ).toThrow();
    }
  );
});
