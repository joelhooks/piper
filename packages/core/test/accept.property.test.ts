import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import {
  AcceptanceSchema,
  accepted,
  ChangedPathsSchema,
  CheckStandingSchema,
} from "../src/accept.js";
import type {
  Acceptance,
  ChangedPaths,
  CheckStanding,
  Requirement,
  ScopeMatch,
  Verdict,
} from "../src/accept.js";
import { ObserveCheckSchema } from "../src/config.js";
import type { ObserveCheck, PiperConfig } from "../src/config.js";
import { oracleMatches } from "./glob-oracle.js";

const names = ["readback", "jobs", "errors", "latency"] as const;

const literal = <const Values extends readonly [string, ...string[]]>(
  values: Values
) => Arbitrary.schema(Schema.Literals(values));

const checkSeed = Arbitrary.all({
  onFail: literal(["alarm", "escalate", "restore"]),
  scope: Arbitrary.array(
    literal([
      "{jobs,scheduler}/**",
      "jobs/*.ts",
      "src/**",
      "**/*.md",
      "*",
      "scheduler/{cron,queue}.ts",
    ]),
    { maxLength: 3, minLength: 1 }
  ),
  scoped: Arbitrary.schema(Schema.Boolean),
});

const decodeCheck = Schema.decodeSync(ObserveCheckSchema);

const namedCheck = checkSeed.pipe(
  Arbitrary.map(
    ({ onFail, scope, scoped }) =>
      (index: number) =>
        decodeCheck(
          scoped
            ? { name: names[index] ?? "", onFail, scope }
            : { name: names[index] ?? "", onFail }
        )
  )
);

const checks = Arbitrary.all({
  first: namedCheck,
  rest: Arbitrary.array(namedCheck, { maxLength: names.length - 1 }),
}).pipe(
  Arbitrary.map(({ first, rest }): PiperConfig["observe"]["checks"] => [
    first(0),
    ...rest.map((check, index) => check(index + 1)),
  ])
);

const verdicts = Arbitrary.array(
  Arbitrary.all({
    check: literal([...names, "unlisted"]),
    note: literal([
      "",
      "owner approved",
      "flaky upstream",
      "piper:",
      "piper: auto retry",
      "piper",
      "Piper: capitalised",
      " piper: leading space",
    ]),
    outcome: literal(["PASS", "FAIL", "OVERRIDE", "ALARM"]),
  }),
  { maxLength: 8 }
);

const changedPaths = Arbitrary.all({
  paths: Arbitrary.array(
    literal([
      "jobs/send.ts",
      "jobs/deep/retry.ts",
      "scheduler/cron.ts",
      "src/main.ts",
      "docs/guide.md",
      "README.md",
      "jobs",
    ]),
    { maxLength: 4 }
  ),
  read: Arbitrary.schema(Schema.Boolean),
}).pipe(
  Arbitrary.map(({ paths, read }) =>
    read
      ? ChangedPathsSchema.cases.Known.make({ paths })
      : ChangedPathsSchema.cases.Unread.make({})
  )
);

const scenarios = Arbitrary.all({ changedPaths, checks, verdicts });

const referenceRequirement = (
  check: ObserveCheck,
  changed: ChangedPaths
): Requirement => {
  const matched: ScopeMatch[] = [];

  if (check.scope === undefined || ChangedPathsSchema.guards.Unread(changed)) {
    return { matched, required: true };
  }

  for (const path of changed.paths) {
    for (const glob of check.scope) {
      if (oracleMatches(glob, path)) {
        matched.push({ glob, path });
      }
    }
  }

  return { matched, required: matched.length > 0 };
};

const referenceStanding = (
  check: ObserveCheck,
  rows: readonly Verdict[],
  changed: ChangedPaths
): CheckStanding => {
  const { matched, required } = referenceRequirement(check, changed);
  let passed = false;
  let overrideNote: string | undefined;
  const failNotes: string[] = [];

  for (const row of rows) {
    if (row.check !== check.name) {
      continue;
    }

    if (row.outcome === "PASS") {
      passed = true;
    }

    if (
      row.outcome === "OVERRIDE" &&
      !row.note.startsWith("piper:") &&
      overrideNote === undefined
    ) {
      overrideNote = row.note;
    }

    if (row.outcome === "FAIL") {
      failNotes.push(row.note);
    }
  }

  const [firstFail, ...laterFails] = failNotes;

  if (!required) {
    return CheckStandingSchema.cases.NotRequired.make({ check: check.name });
  }

  if (passed) {
    return CheckStandingSchema.cases.Passed.make({
      check: check.name,
      matched,
    });
  }

  if (overrideNote !== undefined) {
    return CheckStandingSchema.cases.Overridden.make({
      check: check.name,
      matched,
      note: overrideNote,
    });
  }

  if (firstFail !== undefined) {
    return CheckStandingSchema.cases.Failed.make({
      check: check.name,
      matched,
      notes: [firstFail, ...laterFails],
    });
  }

  return CheckStandingSchema.cases.Pending.make({ check: check.name, matched });
};

const reference = (
  configured: PiperConfig["observe"]["checks"],
  rows: readonly Verdict[],
  changed: ChangedPaths
): Acceptance => {
  const standings = configured.map((check) =>
    referenceStanding(check, rows, changed)
  );

  const [firstFailed, ...laterFailed] = standings.filter(
    CheckStandingSchema.guards.Failed
  );

  const [firstPending, ...laterPending] = standings.filter(
    CheckStandingSchema.guards.Pending
  );

  if (firstFailed !== undefined) {
    return AcceptanceSchema.cases.Refused.make({
      failed: [firstFailed, ...laterFailed],
    });
  }

  if (firstPending !== undefined) {
    return AcceptanceSchema.cases.Waiting.make({
      waiting: [firstPending, ...laterPending],
    });
  }

  return AcceptanceSchema.cases.Accepted.make({
    reasons: standings.flatMap((standing) =>
      CheckStandingSchema.isAnyOf(["NotRequired", "Overridden", "Passed"])(
        standing
      )
        ? [standing]
        : []
    ),
  });
};

describe("accepted", () => {
  it.prop(
    "agrees with a reference implementation for any checks, verdicts and paths",
    { scenario: scenarios },
    ({
      scenario: { changedPaths: changed, checks: configured, verdicts: rows },
    }) => {
      expect(accepted(configured, rows, changed)).toEqual(
        reference(configured, rows, changed)
      );
    },
    { arbitrary: { runs: 2000 } }
  );

  it.effect("the generator reaches every standing and every verdict", () =>
    Effect.gen(function* reach() {
      const samples = yield* Arbitrary.sampleEffect(scenarios, {
        count: 400,
        seed: 23,
      }).pipe(Effect.orDie);

      const outcomes = samples.map((scenario) =>
        reference(scenario.checks, scenario.verdicts, scenario.changedPaths)
      );

      const standings = outcomes.flatMap((outcome): readonly CheckStanding[] =>
        AcceptanceSchema.match(outcome, {
          Accepted: ({ reasons }): readonly CheckStanding[] => reasons,
          Refused: ({ failed }) => failed,
          Waiting: ({ waiting }) => waiting,
        })
      );

      expect([...new Set(outcomes.map(({ _tag }) => _tag))].toSorted()).toEqual(
        ["Accepted", "Refused", "Waiting"]
      );
      expect(
        [...new Set(standings.map(({ _tag }) => _tag))].toSorted()
      ).toEqual(["Failed", "NotRequired", "Overridden", "Passed", "Pending"]);
      expect(
        standings.some(
          (standing) =>
            CheckStandingSchema.isAnyOf(["Failed", "Passed", "Pending"])(
              standing
            ) && standing.matched.length > 0
        )
      ).toBe(true);
    })
  );
});
