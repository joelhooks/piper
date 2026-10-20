import { describe, expect, it } from "@effect/vitest";

import { decideCandidate, decisions } from "../src/candidate.js";
import type { CandidateEvidence } from "../src/candidate.js";

const live = "live-sha";

const main = "main-sha";

const range = { live, main };

const evidence = (
  overrides: Partial<CandidateEvidence> = {}
): CandidateEvidence => ({
  bundleChanged: false,
  changedPaths: ["docs/readme.md"],
  codeOnly: "pass",
  live,
  main,
  migrationDirs: ["migrations"],
  rangeFrom: live,
  ...overrides,
});

const schemaFirst = decisions.SchemaFirst({
  ...range,
  harm: "deploying code that reads a schema production may not have",
  migrations: ["packages/database/migrations/2_add.sql"],
  next: "apply and read back the schema change, then the operator fires this release",
});

const deskFire = decisions.DeskFire({
  ...range,
  harm: "firing a release with more than code changes unattended",
  next: "the operator reviews the plan and fires this release",
});

const missing = (next: string) =>
  decisions.Unknown({
    ...range,
    harm: "acting on missing release evidence",
    next,
  });

describe("release candidate decisions", () => {
  it("does nothing when main is the live release", () => {
    expect(decideCandidate(evidence({ main: live }))).toEqual(
      decisions.Unchanged({ live, main: live })
    );
  });

  it("calls a code-only range with unchanged bundles no-change", () => {
    expect(decideCandidate(evidence())).toEqual(decisions.NoChange(range));
  });

  it("calls a code-only range with a changed bundle a candidate", () => {
    expect(decideCandidate(evidence({ bundleChanged: true }))).toEqual(
      decisions.Candidate(range)
    );
  });

  it("still sees a code change after a later doc-only merge", () => {
    const codeThenDoc = evidence({
      bundleChanged: true,
      changedPaths: ["apps/api/src/route.ts", "docs/readme.md"],
    });

    expect(decideCandidate(codeThenDoc)).toEqual(decisions.Candidate(range));

    expect(
      decideCandidate({
        ...codeThenDoc,
        bundleChanged: false,
        changedPaths: ["docs/readme.md"],
        rangeFrom: "code-sha",
      })
    ).toEqual(
      decisions.Unknown({
        ...range,
        harm: "skipping a change that landed after the live release",
        next: `recompute the evidence from the live release ${live}`,
      })
    );
  });

  it("holds a range that adds a migration whatever else it shows", () => {
    for (const codeOnly of ["pass", "fail", undefined] as const) {
      for (const bundleChanged of [true, false, undefined]) {
        expect(
          decideCandidate(
            evidence({
              bundleChanged,
              changedPaths: [
                "packages/database/migrations/2_add.sql",
                "apps/api/src/route.ts",
              ],
              codeOnly,
            })
          )
        ).toEqual(schemaFirst);
      }
    }
  });

  it("hands a plan that is more than code to the operator", () => {
    for (const bundleChanged of [true, false, undefined]) {
      expect(
        decideCandidate(evidence({ bundleChanged, codeOnly: "fail" }))
      ).toEqual(deskFire);
    }
  });

  it("never calls missing evidence no-change", () => {
    expect(decideCandidate(evidence({ bundleChanged: undefined }))).toEqual(
      missing("supply the bundle-change verdict for this range")
    );

    expect(decideCandidate(evidence({ codeOnly: undefined }))).toEqual(
      missing("run the read-only plan and its code-only check for this range")
    );
  });
});
