import { Array as Arr, Schema } from "effect";

import type { ObserveCheck, PiperConfig } from "./config.js";
import { matchesGlob } from "./glob.js";

export const ChangedPathsSchema = Schema.TaggedUnion({
  Known: { paths: Schema.Array(Schema.String) },
  Unread: {},
});

export type ChangedPaths = typeof ChangedPathsSchema.Type;

export const VerdictSchema = Schema.Struct({
  check: Schema.String,
  note: Schema.String,
  outcome: Schema.Literals(["PASS", "FAIL", "OVERRIDE", "ALARM"]),
});

export type Verdict = typeof VerdictSchema.Type;

export const ScopeMatchSchema = Schema.Struct({
  glob: Schema.String,
  path: Schema.String,
});

export type ScopeMatch = typeof ScopeMatchSchema.Type;

export interface Requirement {
  readonly matched: readonly ScopeMatch[];
  readonly required: boolean;
}

const Matches = Schema.Array(ScopeMatchSchema);

export const CheckStandingSchema = Schema.TaggedUnion({
  Failed: {
    check: Schema.String,
    matched: Matches,
    notes: Schema.NonEmptyArray(Schema.String),
  },
  NotRequired: { check: Schema.String },
  Overridden: { check: Schema.String, matched: Matches, note: Schema.String },
  Passed: { check: Schema.String, matched: Matches },
  Pending: { check: Schema.String, matched: Matches },
});

export type CheckStanding = typeof CheckStandingSchema.Type;

const { Failed, NotRequired, Overridden, Passed, Pending } =
  CheckStandingSchema.cases;

export const AcceptanceSchema = Schema.TaggedUnion({
  Accepted: {
    reasons: Schema.Array(Schema.Union([NotRequired, Overridden, Passed])),
  },
  Refused: { failed: Schema.NonEmptyArray(Failed) },
  Waiting: { waiting: Schema.NonEmptyArray(Pending) },
});

export type Acceptance = typeof AcceptanceSchema.Type;

const selfOverride = "piper:";

const always: Requirement = { matched: [], required: true };

export const checkRequired = (
  { scope }: ObserveCheck,
  changedPaths: ChangedPaths
): Requirement =>
  scope === undefined
    ? always
    : ChangedPathsSchema.match(changedPaths, {
        Known: ({ paths }) => {
          const hits = paths.flatMap((path) =>
            scope.flatMap((glob) =>
              matchesGlob(glob, path) ? [{ glob, path }] : []
            )
          );

          return { matched: hits, required: hits.length > 0 };
        },
        Unread: () => always,
      });

const humanOverride = ({ note, outcome }: Verdict) =>
  outcome === "OVERRIDE" && !note.startsWith(selfOverride);

const standingOf = (
  check: ObserveCheck,
  verdicts: readonly Verdict[],
  changedPaths: ChangedPaths
): CheckStanding => {
  const { matched, required } = checkRequired(check, changedPaths);

  if (!required) {
    return NotRequired.make({ check: check.name });
  }

  const rows = verdicts.filter((row) => row.check === check.name);
  const override = rows.find(humanOverride);

  const failures = rows.flatMap(({ note, outcome }) =>
    outcome === "FAIL" ? [note] : []
  );

  const subject = { check: check.name, matched };

  if (rows.some(({ outcome }) => outcome === "PASS")) {
    return Passed.make(subject);
  }

  if (override !== undefined) {
    return Overridden.make({ ...subject, note: override.note });
  }

  return Arr.isReadonlyArrayNonEmpty(failures)
    ? Failed.make({ ...subject, notes: failures })
    : Pending.make(subject);
};

export const accepted = (
  checks: PiperConfig["observe"]["checks"],
  verdicts: readonly Verdict[],
  changedPaths: ChangedPaths
): Acceptance => {
  const standings = checks.map((check) =>
    standingOf(check, verdicts, changedPaths)
  );

  const failed = standings.filter(CheckStandingSchema.guards.Failed);
  const waiting = standings.filter(CheckStandingSchema.guards.Pending);

  if (Arr.isReadonlyArrayNonEmpty(failed)) {
    return AcceptanceSchema.cases.Refused.make({ failed });
  }

  if (Arr.isReadonlyArrayNonEmpty(waiting)) {
    return AcceptanceSchema.cases.Waiting.make({ waiting });
  }

  return AcceptanceSchema.cases.Accepted.make({
    reasons: standings.filter(
      CheckStandingSchema.isAnyOf(["NotRequired", "Overridden", "Passed"])
    ),
  });
};
