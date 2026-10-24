import { describe, expect, it } from "@effect/vitest";
import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { GitHub } from "@joelhooks/piper-executor/github";
import { Effect } from "effect";

import { readChecks } from "../src/feed.js";

const runsPath = "/actions/runs?head_sha=car-a&per_page=100";

const checksPath =
  "/commits/car-a/check-runs?filter=latest&per_page=100&page=1";

const check = (id: number, name: string, conclusion: string, suite?: number) =>
  suite === undefined
    ? { conclusion, head_sha: "car-a", id, name, status: "completed" }
    : {
        check_suite: { id: suite },
        conclusion,
        head_sha: "car-a",
        id,
        name,
        status: "completed",
      };

const run = (id: number, suite: number, createdAt: string) => ({
  check_suite_id: suite,
  created_at: createdAt,
  event: "pull_request",
  id,
  run_attempt: 1,
  workflow_id: 7,
});

const checkRuns = [
  check(1, "matrix (unexpanded group)", "cancelled", 1),
  check(2, "unit", "failure", 1),
  check(3, "unit", "success", 2),
  check(4, "external status", "success"),
];

const fake = (responses: ReadonlyMap<string, unknown>): GitHub["Service"] => ({
  read: (_repo, path) =>
    responses.has(path)
      ? Effect.succeed(responses.get(path))
      : Effect.fail(new ExecutorError({ code: "not-found", message: path })),
});

const observe = (responses: ReadonlyMap<string, unknown>) =>
  readChecks("sample/project", "car-a").pipe(
    Effect.provideService(GitHub, fake(responses))
  );

describe("shadow check reads", () => {
  it.effect(
    "a reopened run's older workflow run no longer speaks for the head",
    () =>
      Effect.gen(function* test() {
        const checks = yield* observe(
          new Map<string, unknown>([
            [
              runsPath,
              {
                total_count: 2,
                workflow_runs: [
                  run(20, 2, "2026-01-01T00:05:00Z"),
                  run(10, 1, "2026-01-01T00:00:00Z"),
                ],
              },
            ],
            [checksPath, { check_runs: checkRuns, total_count: 4 }],
          ])
        );

        expect(checks.map((entry) => [entry.name, entry.conclusion])).toEqual([
          ["unit", "success"],
          ["external status", "success"],
        ]);
      })
  );

  it.effect(
    "an unread workflow run list falls back to the newest check per name",
    () =>
      Effect.gen(function* test() {
        const checks = yield* observe(
          new Map<string, unknown>([
            [checksPath, { check_runs: checkRuns, total_count: 4 }],
          ])
        );

        expect(checks.map((entry) => [entry.name, entry.conclusion])).toEqual([
          ["matrix (unexpanded group)", "cancelled"],
          ["unit", "success"],
          ["external status", "success"],
        ]);
      })
  );

  it.effect("an undecodable workflow run list falls back the same way", () =>
    Effect.gen(function* test() {
      const checks = yield* observe(
        new Map<string, unknown>([
          [runsPath, { workflow_runs: "unreadable" }],
          [checksPath, { check_runs: checkRuns, total_count: 4 }],
        ])
      );

      expect(checks.map((entry) => entry.name)).toEqual([
        "matrix (unexpanded group)",
        "unit",
        "external status",
      ]);
    })
  );
});
