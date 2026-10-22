import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { Candidate } from "../src/domain.js";
import { TrainInputSchema } from "../src/domain.js";
import { isEligible, selectCars, verdictOn } from "../src/policy.js";
import { input } from "./fixtures.js";

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

describe("lone car boarding", () => {
  const rules = {
    candidateIgnoredChecks: ["full suites"],
    candidateRequiredChecks: [["light suites"]],
    ignoredChecks: ["advisory"],
    trainLabel: "train",
  };

  const boarded = (pool: readonly Candidate[]) =>
    selectCars(pool, 2, rules).map((entry) => entry.number);

  const shared = (
    pool: readonly Candidate[],
    sharedBoarding: "ownCiGreen" | "notKnownRed"
  ) =>
    selectCars(pool, 3, { ...rules, sharedBoarding }).map(
      (entry) => entry.number
    );

  it("boards a lone car on push while its checks are absent or pending, never past a known red", () => {
    expect(boarded([car([])])).toEqual([41]);
    expect(
      boarded([car([checkRun("light suites", "in_progress", null)])])
    ).toEqual([41]);
    expect(
      boarded([car([checkRun("full suites", "completed", "failure")])])
    ).toEqual([41]);
    expect(
      boarded([car([checkRun("advisory", "completed", "failure")])])
    ).toEqual([41]);
    expect(
      boarded([car([checkRun("light suites", "completed", "failure")])])
    ).toEqual([]);
    expect(
      boarded([
        car([
          checkRun("light suites", "in_progress", null),
          checkRun("side coverage", "completed", "failure"),
        ]),
      ])
    ).toEqual([]);
  });

  it("keeps the label, review and up-to-date gates for a lone car", () => {
    const pending = car([checkRun("light suites", "in_progress", null)]);

    expect(boarded([{ ...pending, labels: [] }])).toEqual([]);
    expect(boarded([{ ...pending, operatorReviewed: false }])).toEqual([]);
    expect(boarded([{ ...pending, upToDate: false }])).toEqual([]);
    expect(
      selectCars([{ ...pending, upToDate: false }], 1, {
        ...rules,
        requireUpToDate: false,
      }).map((entry) => entry.number)
    ).toEqual([41]);
  });

  it("keeps the light-done rule when two cars share the group", () => {
    const pending = car([checkRun("light suites", "in_progress", null)]);

    const done = {
      ...car([checkRun("light suites", "completed", "success")]),
      number: 42,
    };

    expect(boarded([pending, done])).toEqual([42]);
    expect(boarded([pending, { ...pending, number: 43 }])).toEqual([]);
    expect(boarded([pending, { ...pending, checks: [] }])).toEqual([41]);
  });

  it("boards a shared group on the lone rule under notKnownRed, never past a known red", () => {
    const pending = car([checkRun("light suites", "in_progress", null)]);

    const done = {
      ...car([checkRun("light suites", "completed", "success")]),
      number: 42,
    };

    const red = {
      ...car([checkRun("side coverage", "completed", "failure")]),
      number: 43,
    };

    expect(shared([pending, done], "notKnownRed")).toEqual([41, 42]);
    expect(
      shared([pending, { ...car([]), number: 44 }], "notKnownRed")
    ).toEqual([41, 44]);
    expect(shared([pending, red, done], "notKnownRed")).toEqual([41, 42]);
    expect(shared([pending, done], "ownCiGreen")).toEqual([42]);
  });

  it("accepts only the two named shared boarding rules", () => {
    const valid = Schema.is(TrainInputSchema);

    expect(valid({ ...input(1), sharedBoarding: "notKnownRed" })).toBe(true);
    expect(valid({ ...input(1), sharedBoarding: "ownCiGreen" })).toBe(true);
    expect(valid({ ...input(1), sharedBoarding: "always" })).toBe(false);
  });
});
