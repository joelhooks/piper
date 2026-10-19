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
});
