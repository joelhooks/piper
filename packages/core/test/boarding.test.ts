import { describe, expect, it } from "vitest";

import type { Candidate } from "../src/domain.js";
import { isEligible, verdictOn } from "../src/policy.js";

const head = "synthetic-revision-41";

const candidate: Candidate = {
  checks: [
    {
      conclusion: "success",
      headSha: head,
      name: "light suites",
      status: "completed",
    },
    {
      conclusion: "failure",
      headSha: head,
      name: "full suites",
      status: "completed",
    },
  ],
  headSha: head,
  labels: ["train"],
  number: 41,
  operatorReviewed: true,
  owner: "synthetic-author",
  upToDate: true,
};

const checkRun = (
  name: string,
  status: "completed" | "in_progress",
  conclusion: "success" | "failure" | "skipped" | null
) => ({ conclusion, headSha: head, name, status });

const car = (checks: Candidate["checks"]) => ({ ...candidate, checks });

describe("boarding checks", () => {
  it("lets a car board when only a boarding-ignored check is red", () => {
    expect(
      isEligible(candidate, { ignoredChecks: [], trainLabel: "train" })
    ).toBe(false);

    expect(
      isEligible(candidate, {
        candidateIgnoredChecks: ["full suites"],
        ignoredChecks: [],
        trainLabel: "train",
      })
    ).toBe(true);
  });

  it("still judges the train head on the boarding-ignored check", () => {
    expect(verdictOn(head, candidate.checks, [])._tag).toBe("Red");
  });

  it("boards a car behind main only when the rules allow it", () => {
    const behind = { ...candidate, checks: [], upToDate: false };
    const rules = { ignoredChecks: [], trainLabel: "train" };

    const green = {
      ...behind,
      checks: [candidate.checks[0]].flatMap((run) =>
        run === undefined ? [] : [run]
      ),
    };

    expect(isEligible(green, rules)).toBe(false);
    expect(isEligible(green, { ...rules, requireUpToDate: false })).toBe(true);
  });

  it("boards when any required group passes while other checks still run, but never past a finished failure", () => {
    const rules = {
      candidateRequiredChecks: [
        ["light suites", "mode"],
        ["full light", "mode"],
      ],
      ignoredChecks: ["advisory"],
      trainLabel: "train",
    };

    const mode = checkRun("mode", "completed", "success");

    expect(
      isEligible(
        car([
          checkRun("light suites", "completed", "success"),
          mode,
          checkRun("side coverage", "in_progress", null),
          checkRun("advisory", "completed", "failure"),
        ]),
        rules
      )
    ).toBe(true);
    expect(
      isEligible(
        car([
          checkRun("light suites", "completed", "skipped"),
          checkRun("full light", "completed", "success"),
          mode,
          checkRun("side coverage", "in_progress", null),
        ]),
        rules
      )
    ).toBe(true);
    expect(
      isEligible(
        car([checkRun("light suites", "completed", "skipped"), mode]),
        rules
      )
    ).toBe(false);
    expect(
      isEligible(
        car([
          checkRun("light suites", "completed", "success"),
          mode,
          checkRun("side coverage", "completed", "failure"),
        ]),
        rules
      )
    ).toBe(false);
    expect(
      isEligible(
        car([checkRun("light suites", "in_progress", null), mode]),
        rules
      )
    ).toBe(false);
    expect(
      isEligible(
        car([
          checkRun("light suites", "completed", "success"),
          mode,
          checkRun("side coverage", "in_progress", null),
        ]),
        { ...rules, candidateRequiredChecks: [] }
      )
    ).toBe(false);
  });
});
