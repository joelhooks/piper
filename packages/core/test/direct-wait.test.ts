import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { Candidate, CheckRun, TrainInput } from "../src/domain.js";
import { TrainInputSchema } from "../src/domain.js";
import { openTrain, readTrain, stateName, stepTrain } from "../src/host.js";
import { input, T0 } from "./fixtures.js";
import { jsonSnapshot } from "./json-snapshot.js";

const rules: TrainInput = {
  ...input(1),
  candidateIgnoredChecks: ["gate"],
  ciTimeoutMs: 60_000,
  directRequiredChecks: [["build"], ["gate"]],
  directWaitChecks: ["gate"],
};

const check = (
  name: string,
  status: CheckRun["status"] = "completed",
  conclusion: CheckRun["conclusion"] = "success",
  headSha = "head"
): CheckRun => ({ conclusion, headSha, name, status });

const candidate = (
  checks: readonly CheckRun[] = [
    check("build"),
    check("gate", "in_progress", null),
  ]
): Candidate => ({
  checks,
  headSha: "head",
  labels: ["train"],
  number: 1,
  operatorReviewed: true,
  owner: "contributor/one",
  upToDate: true,
});

const collect = (pool: readonly Candidate[], at = T0) => ({
  at,
  candidates: pool,
  main: "main",
  type: "candidates" as const,
});

const start = Effect.fn("DirectWait.start")(function* start(
  pool: readonly Candidate[] = [candidate()],
  config: TrainInput = rules
) {
  return yield* stepTrain(yield* openTrain(config), [
    collect(pool),
    { at: T0, type: "depart" },
  ]);
});

const departed = Effect.fn("DirectWait.departed")(function* departed(
  pool: readonly Candidate[],
  config: TrainInput,
  path: "lone-board" | "direct-land"
) {
  const snapshot = yield* readTrain(yield* start(pool, config));
  expect(snapshot.context.facts).toContainEqual(
    expect.objectContaining({ kind: "departed", path })
  );
  expect(snapshot.context.directWait).toBeUndefined();
});

describe("direct landing waits", () => {
  it.effect.prop(
    "every configured bound holds strictly before and boards at its deadline",
    {
      timeoutMs: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 600_000, minimum: 1 }))
      ),
    },
    ({ timeoutMs }) =>
      Effect.gen(function* generatedDeadline() {
        const held = yield* start([candidate()], {
          ...rules,
          directWaitMs: timeoutMs,
        });

        const before = yield* stepTrain(held, [
          { at: T0 + timeoutMs - 1, type: "depart" },
        ]);

        expect(stateName(yield* readTrain(before))).toBe("collecting");

        const expired = yield* readTrain(
          yield* stepTrain(before, [{ at: T0 + timeoutMs, type: "depart" }])
        );

        expect(stateName(expired)).toBe("building");
        expect(expired.context.facts).toContainEqual(
          expect.objectContaining({ path: "lone-board" })
        );
      }),
    { arbitrary: { runs: 50 } }
  );
  it.effect(
    "holds without departure effects, persists the start, then lands on fresh green",
    () =>
      Effect.gen(function* test() {
        const held = yield* start();
        const snapshot = yield* readTrain(held);
        expect(stateName(snapshot)).toBe("collecting");
        expect(snapshot.context.intents).toEqual([]);
        expect(snapshot.context.facts).toEqual([]);
        expect(snapshot.context.directWait).toEqual({
          head: "head",
          pr: 1,
          reason:
            "waiting up to 1 min for gate to finish before landing directly",
          since: T0,
        });
        const restored = jsonSnapshot(held);

        const again = yield* stepTrain(restored, [
          collect([candidate()], T0 + 30_000),
          { at: T0 + 30_000, type: "depart" },
        ]);

        expect((yield* readTrain(again)).context.directWait?.since).toBe(T0);

        const green = yield* readTrain(
          yield* stepTrain(again, [
            collect([candidate([check("build"), check("gate")])], T0 + 40_000),
            { at: T0 + 40_000, type: "depart" },
          ])
        );

        expect(stateName(green)).toBe("direct.awaitingGo");
        expect(green.context.directWait).toBeUndefined();
        expect(green.context.facts).toContainEqual(
          expect.objectContaining({ path: "direct-land" })
        );
      })
  );

  it.effect(
    "bounds the wait from the first depart timestamp, including equality",
    () =>
      Effect.gen(function* test() {
        const held = yield* start();

        const before = yield* stepTrain(held, [
          { at: T0 + 59_999, type: "depart" },
        ]);

        expect(stateName(yield* readTrain(before))).toBe("collecting");

        const expired = yield* readTrain(
          yield* stepTrain(before, [{ at: T0 + 60_000, type: "depart" }])
        );

        expect(stateName(expired)).toBe("building");
        expect(expired.context.directWait).toBeUndefined();
        expect(expired.context.facts).toContainEqual(
          expect.objectContaining({
            path: "lone-board",
            reason: "gate did not finish within 1 min; boarding a lone train",
          })
        );
      })
  );

  it.effect("multiple queued and running waited checks hold together", () =>
    Effect.gen(function* multipleChecks() {
      const held = yield* start(
        [
          candidate([
            check("build"),
            check("gate", "queued", null),
            check("analysis", "in_progress", null),
          ]),
        ],
        { ...rules, directWaitChecks: ["gate", "analysis", "gate"] }
      );

      expect((yield* readTrain(held)).context.directWait?.reason).toBe(
        "waiting up to 1 min for analysis, gate to finish before landing directly"
      );
    })
  );

  it.effect("ignored running checks never start a direct wait", () =>
    departed(
      [
        candidate([
          check("build"),
          check("gate"),
          check("branch-current", "in_progress", null),
        ]),
      ],
      { ...rules, directWaitChecks: ["branch-current"] },
      "direct-land"
    )
  );

  it.effect("a waited check turning red clears the wait and boards", () =>
    Effect.gen(function* turnsRed() {
      const held = yield* start();

      const red = yield* readTrain(
        yield* stepTrain(held, [
          collect(
            [
              candidate([
                check("build"),
                check("gate", "completed", "failure"),
              ]),
            ],
            T0 + 1
          ),
          { at: T0 + 1, type: "depart" },
        ])
      );

      expect(red.context.directWait).toBeUndefined();
      expect(red.context.facts).toContainEqual(
        expect.objectContaining({ path: "lone-board" })
      );
    })
  );

  it.effect("a completed red waited check still takes a lone train", () =>
    departed(
      [candidate([check("build"), check("gate", "completed", "failure")])],
      rules,
      "lone-board"
    )
  );

  it.effect("another running check does not wait", () =>
    departed(
      [
        candidate([
          check("build", "in_progress", null),
          check("gate", "in_progress", null),
        ]),
      ],
      rules,
      "lone-board"
    )
  );

  it.effect(
    "absent and empty rules preserve the old pending departure and reason",
    () =>
      Effect.gen(function* test() {
        const { directWaitChecks: _checks, ...off } = rules;

        for (const config of [off, { ...rules, directWaitChecks: [] }]) {
          const snapshot = yield* readTrain(
            yield* start([candidate()], config)
          );

          expect(snapshot.context.facts).toContainEqual(
            expect.objectContaining({
              path: "lone-board",
              reason:
                "it rides alone, so boarding skips the wait for its own CI; it takes a train because its own CI has not finished",
            })
          );
        }
      })
  );

  it.effect(
    "new heads, different cars, and non-lone pools clear the wait immediately",
    () =>
      Effect.gen(function* test() {
        for (const pool of [
          [
            {
              ...candidate(),
              checks: [
                check("build", "completed", "success", "next"),
                check("gate", "in_progress", null, "next"),
              ],
              headSha: "next",
            },
          ],
          [{ ...candidate(), number: 2 }],
          [candidate(), { ...candidate(), number: 2 }],
          [],
        ]) {
          const held = yield* start();
          const changed = yield* stepTrain(held, [collect(pool, T0 + 30_000)]);
          expect(
            (yield* readTrain(changed)).context.directWait
          ).toBeUndefined();

          if (pool.length === 1) {
            const waiting = yield* readTrain(
              yield* stepTrain(changed, [{ at: T0 + 60_000, type: "depart" }])
            );

            expect(stateName(waiting)).toBe("collecting");
            expect(waiting.context.directWait?.since).toBe(T0 + 60_000);
          }
        }
      })
  );

  it.effect(
    "does not wait when direct landing is off, behind main, or missing another direct check",
    () =>
      Effect.gen(function* test() {
        yield* departed(
          [candidate()],
          { ...rules, directRequiredChecks: [] },
          "lone-board"
        );
        yield* departed(
          [{ ...candidate(), upToDate: false }],
          { ...rules, requireUpToDate: false },
          "lone-board"
        );
        yield* departed(
          [candidate()],
          { ...rules, directRequiredChecks: [["missing"]] },
          "lone-board"
        );
      })
  );

  it.effect("absent checks and checks on other heads keep today's path", () =>
    Effect.gen(function* test() {
      for (const checks of [
        [check("build")],
        [check("build"), check("gate", "completed", "success", "old-head")],
      ]) {
        yield* departed([candidate(checks)], rules, "lone-board");
        yield* departed(
          [candidate(checks)],
          { ...rules, directRequiredChecks: [["build"]] },
          "direct-land"
        );
      }
    })
  );

  it.effect("repeated depart is a no-op only with the rule enabled", () =>
    Effect.gen(function* test() {
      for (const directWaitChecks of [[], ["gate"]]) {
        const train = yield* start(
          [candidate([check("build"), check("gate")])],
          { ...rules, directWaitChecks }
        );

        const before = yield* readTrain(train);

        const after = yield* readTrain(
          yield* stepTrain(train, [{ at: T0 + 1, type: "depart" }])
        );

        expect(after.context).toEqual({
          ...before.context,
          rejected:
            directWaitChecks.length === 0
              ? [
                  {
                    at: T0 + 1,
                    state: JSON.stringify({ direct: "awaitingGo" }),
                    type: "depart",
                  },
                ]
              : before.context.rejected,
          sync: after.context.sync,
        });
        expect(stateName(after)).toBe(stateName(before));
      }
    })
  );

  it.effect(
    "the latest unfinished attempt waits instead of an earlier green",
    () =>
      Effect.gen(function* latestAttempt() {
        const held = yield* start([
          candidate([
            check("build"),
            { ...check("gate"), attempt: 1 },
            { ...check("gate", "in_progress", null), attempt: 2 },
          ]),
        ]);

        expect(stateName(yield* readTrain(held))).toBe("collecting");
      })
  );

  it.effect("a separate five-minute bound expires exactly at 300000 ms", () =>
    Effect.gen(function* separateBound() {
      const held = yield* start([candidate()], {
        ...rules,
        ciTimeoutMs: 600_000,
        directWaitMs: 300_000,
      });

      expect((yield* readTrain(held)).context.directWait?.reason).toContain(
        "5 min"
      );

      const before = yield* stepTrain(held, [
        { at: T0 + 299_999, type: "depart" },
      ]);

      expect(stateName(yield* readTrain(before))).toBe("collecting");

      const expired = yield* readTrain(
        yield* stepTrain(before, [{ at: T0 + 300_000, type: "depart" }])
      );

      expect(stateName(expired)).toBe("building");
      expect(expired.context.facts).toContainEqual(
        expect.objectContaining({
          path: "lone-board",
          reason: "gate did not finish within 5 min; boarding a lone train",
        })
      );
    })
  );

  it.effect(
    "absent-rule facts and intents preserve both existing departure paths",
    () =>
      Effect.gen(function* existingPaths() {
        const { directWaitChecks: _checks, ...off } = rules;

        for (const green of [true, false]) {
          const car = candidate([
            check("build"),
            check(
              "gate",
              green ? "completed" : "in_progress",
              green ? "success" : null
            ),
          ]);

          const snapshot = yield* readTrain(yield* start([car], off));

          expect(snapshot.context.rejected).toEqual([]);
          expect(snapshot.context.facts).toEqual([
            {
              at: T0,
              base: "main",
              cars: [1],
              kind: "departed",
              path: green ? "direct-land" : "lone-board",
              reason: green
                ? "it rides alone, its head contains main and its own CI is green on every direct check group"
                : "it rides alone, so boarding skips the wait for its own CI; it takes a train because its own CI has not finished",
            },
          ]);
          expect(snapshot.context.intents).toEqual(
            green
              ? []
              : [
                  {
                    at: T0,
                    base: "main",
                    branch: "train/1",
                    buildId: 1,
                    cars: [
                      { headSha: "head", number: 1, owner: "contributor/one" },
                    ],
                    id: "train-1/1",
                    kind: "BuildTrain",
                    purpose: "train",
                  },
                ]
          );
        }
      })
  );

  it.effect("admission parsing preserves the optional rule", () =>
    Effect.gen(function* test() {
      expect(
        (yield* Schema.decodeUnknownEffect(TrainInputSchema)(rules))
          .directWaitChecks
      ).toEqual(["gate"]);
    })
  );
});
