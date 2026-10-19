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
import { releaseHappy, releaseInput } from "./release-fixtures.js";

const generated = Arbitrary.schema(
  Schema.Struct({
    by: Schema.NonEmptyString,
    delay: Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 })),
    evidence: Schema.NonEmptyString,
  })
);

const deployed = releaseHappy.slice(0, 4);

const observing = Effect.gen(function* observingRelease() {
  return yield* stepRelease(yield* openRelease(releaseInput), deployed);
});

const lastAt = deployed.at(-1)?.at ?? 0;

describe("superseded releases", () => {
  it.effect.prop(
    "a successor ends an observing run with no restore and no page",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* superseded() {
        const at = lastAt + sample.delay;

        const after = yield* stepRelease(yield* observing, [
          {
            at,
            by: sample.by,
            evidence: sample.evidence,
            type: "superseded",
          },
        ]);

        const view = viewRelease(yield* readRelease(after));

        expect(view.state).toBe("superseded");
        expect(view.status).toBe("done");
        expect(view.alarmAt).toBeUndefined();
        expect(
          view.intents.filter(
            (intent) =>
              intent.kind === "Restore" || intent.kind === "NotifyOwner"
          )
        ).toEqual([]);
        expect(view.facts.at(-1)).toMatchObject({
          by: sample.by,
          evidence: sample.evidence,
          kind: "superseded",
          state: "superseded",
        });
      })
  );

  it.effect.prop(
    "a breach after supersession restores nothing",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* moot() {
        const at = lastAt + sample.delay;

        const superseded = yield* stepRelease(yield* observing, [
          {
            at,
            by: sample.by,
            evidence: sample.evidence,
            type: "superseded",
          },
        ]);

        const before = viewRelease(yield* readRelease(superseded));

        const breach: ReleaseEvent = {
          at: at + 1,
          check: "availability",
          outcome: "breach",
          type: "observed",
        };

        const after = yield* stepRelease(superseded, [breach]).pipe(
          Effect.catchTag("ReleaseFinished", () => Effect.succeed(superseded))
        );

        expect(viewRelease(yield* readRelease(after))).toEqual(before);
      })
  );

  it.effect.prop(
    "a failure that completed before supersession keeps its outcome",
    { generated },
    ({ generated: sample }) =>
      Effect.gen(function* earlier() {
        const at = lastAt + sample.delay;

        const restored = yield* stepRelease(yield* observing, [
          {
            at,
            check: "availability",
            outcome: "breach",
            type: "observed",
          },
          {
            at: at + 1,
            by: sample.by,
            evidence: sample.evidence,
            type: "superseded",
          },
        ]);

        const view = viewRelease(yield* readRelease(restored));

        expect(view.state).toBe("restoring");
        expect(view.intents.at(-1)?.kind).toBe("Restore");
      })
  );

  it.effect("supersession outside observing changes nothing", () =>
    Effect.gen(function* outside() {
      const armed = yield* stepRelease(
        yield* openRelease(releaseInput),
        releaseHappy.slice(0, 2)
      );

      const before = viewRelease(yield* readRelease(armed));

      const after = yield* stepRelease(armed, [
        {
          at: 500,
          by: "successor",
          evidence: "partial window",
          type: "superseded",
        },
      ]);

      expect(viewRelease(yield* readRelease(after))).toEqual(before);
    })
  );
});
