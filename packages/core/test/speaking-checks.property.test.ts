import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { CheckRun, WorkflowRun } from "../src/domain.js";
import type { SuiteCheck } from "../src/policy.js";
import { speakingChecks, supersededSuites, verdictOn } from "../src/policy.js";

const small = (maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum: 0 }));

const generatedRun = Schema.Struct({
  createdAt: small(4),
  event: Schema.Literals(["pull_request", "push"]),
  workflow: small(2),
});

const generatedCheck = Schema.Struct({
  name: Schema.Literals(["unit", "lint", "e2e", "deploy"]),
  suite: Schema.optionalKey(small(5)),
});

const generated = Arbitrary.schema(
  Schema.Struct({
    checks: Schema.Array(generatedCheck).check(Schema.isMaxLength(16)),
    runs: Schema.Array(generatedRun).check(Schema.isMaxLength(6)),
  })
);

const build = (sample: {
  readonly checks: readonly (typeof generatedCheck.Type)[];
  readonly runs: readonly (typeof generatedRun.Type)[];
}) => {
  const runs: readonly WorkflowRun[] = sample.runs.map((run, index) => ({
    ...run,
    checkSuite: index,
    id: 100 + index,
  }));

  const checks = sample.checks.map((check, index) =>
    check.suite === undefined || check.suite >= runs.length
      ? { id: index, name: check.name }
      : { id: index, name: check.name, suite: check.suite }
  );

  return { checks, runs };
};

const newestByName = (
  checks: readonly { readonly id: number; readonly name: string }[]
) => {
  const newest = new Map<string, number>();

  for (const check of checks) {
    newest.set(check.name, Math.max(check.id, newest.get(check.name) ?? -1));
  }

  return newest;
};

const observed = (
  id: number,
  name: string,
  conclusion: CheckRun["conclusion"],
  suite?: number
): CheckRun & SuiteCheck => ({
  conclusion,
  headSha: "head-a",
  id,
  name,
  status: "completed",
  suite,
});

describe("speaking checks", () => {
  it.prop(
    "no speaking check belongs to a superseded workflow run",
    { generated },
    ({ generated: sample }) => {
      const { checks, runs } = build(sample);
      const superseded = supersededSuites(runs);

      expect(
        speakingChecks(checks, runs).filter(
          (check) => "suite" in check && superseded.has(check.suite)
        )
      ).toEqual([]);
    }
  );

  it.prop(
    "each workflow and event keeps exactly its newest run",
    { generated },
    ({ generated: sample }) => {
      const { runs } = build(sample);
      const superseded = supersededSuites(runs);

      for (const run of runs) {
        const twins = runs.filter(
          (other) =>
            other.workflow === run.workflow && other.event === run.event
        );

        let newest = run;

        for (const other of twins) {
          if (
            other.createdAt > newest.createdAt ||
            (other.createdAt === newest.createdAt && other.id > newest.id)
          ) {
            newest = other;
          }
        }

        expect(superseded.has(run.checkSuite)).toBe(newest !== run);
      }
    }
  );

  it.prop(
    "the newest unsuperseded check speaks for each name",
    { generated },
    ({ generated: sample }) => {
      const { checks, runs } = build(sample);
      const superseded = supersededSuites(runs);

      const eligible = checks.filter(
        (check) => !("suite" in check) || !superseded.has(check.suite)
      );

      const speaking = speakingChecks(checks, runs);

      expect(new Map(speaking.map((check) => [check.name, check.id]))).toEqual(
        newestByName(eligible)
      );
      expect(new Set(speaking.map((check) => check.name)).size).toBe(
        speaking.length
      );
    }
  );

  it.prop(
    "an unread workflow run list dedupes by name alone",
    { generated },
    ({ generated: sample }) => {
      const { checks } = build(sample);

      expect(
        new Map(
          speakingChecks(checks, []).map((check) => [check.name, check.id])
        )
      ).toEqual(newestByName(checks));
    }
  );

  it("drops a superseded run's reds, including names the newer run lacks", () => {
    const runs: readonly WorkflowRun[] = [
      {
        checkSuite: 1,
        createdAt: 1000,
        event: "pull_request",
        id: 10,
        workflow: 7,
      },
      {
        checkSuite: 2,
        createdAt: 2000,
        event: "pull_request",
        id: 20,
        workflow: 7,
      },
    ];

    const checks = [
      observed(1, "matrix (unexpanded group)", "cancelled", 1),
      observed(2, "unit", "failure", 1),
      observed(3, "unit", "success", 2),
      observed(4, "matrix one", "success", 2),
      observed(5, "external status", "success"),
    ];

    const speaking = speakingChecks(checks, runs);

    expect(speaking.map((check) => check.id)).toEqual([3, 4, 5]);
    expect(verdictOn("head-a", speaking, [])._tag).toBe("Green");
  });
});
