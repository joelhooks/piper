import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { ExecutorError } from "../src/domain.js";
import { readChecks } from "../src/execute.js";
import { GitHub } from "../src/github.js";

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

const run = (id: number, suite: number, createdAt: string, attempt = 1) => ({
  check_suite_id: suite,
  created_at: createdAt,
  event: "pull_request",
  id,
  run_attempt: attempt,
  workflow_id: 7,
});

const responses = new Map<string, unknown>([
  [
    "/actions/runs?head_sha=car-a&per_page=100",
    {
      total_count: 2,
      workflow_runs: [
        run(20, 2, "2026-01-01T00:05:00Z", 2),
        run(10, 1, "2026-01-01T00:00:00Z"),
      ],
    },
  ],
  [
    "/commits/car-a/check-runs?filter=latest&per_page=100&page=1",
    {
      check_runs: [
        check(1, "matrix (unexpanded group)", "cancelled", 1),
        check(2, "unit", "failure", 1),
        check(3, "unit", "success", 2),
        check(4, "external status", "success"),
      ],
      total_count: 4,
    },
  ],
]);

const fake: GitHub["Service"] = {
  read: (_repo, path) =>
    responses.has(path)
      ? Effect.succeed(responses.get(path))
      : Effect.fail(new ExecutorError({ code: "not-found", message: path })),
};

const stuck = (
  runStatus: string,
  overrides: {
    readonly conclusion?: string | null;
    readonly completed_at?: string | null;
  }
) => {
  const paths = new Map<string, unknown>([
    [
      "/actions/runs?head_sha=car-b&per_page=100",
      {
        total_count: 1,
        workflow_runs: [
          { ...run(30, 3, "2026-01-01T00:00:00Z"), status: runStatus },
        ],
      },
    ],
    [
      "/commits/car-b/check-runs?filter=latest&per_page=100&page=1",
      {
        check_runs: [
          {
            check_suite: { id: 3 },
            completed_at: "2026-01-01T00:00:10Z",
            conclusion: "success",
            head_sha: "car-b",
            id: 5,
            name: "CI mode",
            status: "in_progress",
            ...overrides,
          },
        ],
        total_count: 1,
      },
    ],
  ]);

  const service: GitHub["Service"] = {
    read: (_repo, path) =>
      paths.has(path)
        ? Effect.succeed(paths.get(path))
        : Effect.fail(new ExecutorError({ code: "not-found", message: path })),
  };

  return readChecks("sample/project", "car-b").pipe(
    Effect.provideService(GitHub, service),
    Effect.map((checks) => checks.map((c) => c.status))
  );
};

describe("executor check reads: a check GitHub left at in_progress", () => {
  it.effect(
    "settles when it has a conclusion and completed_at and its run completed",
    () =>
      Effect.gen(function* test() {
        expect(yield* stuck("completed", {})).toEqual(["completed"]);
      })
  );

  it.effect("stays in_progress while its workflow run is still running", () =>
    Effect.gen(function* test() {
      expect(yield* stuck("in_progress", {})).toEqual(["in_progress"]);
    })
  );

  it.effect("stays in_progress without a conclusion", () =>
    Effect.gen(function* test() {
      expect(yield* stuck("completed", { conclusion: null })).toEqual([
        "in_progress",
      ]);
    })
  );

  it.effect("stays in_progress without a completed_at", () =>
    Effect.gen(function* test() {
      expect(yield* stuck("completed", { completed_at: null })).toEqual([
        "in_progress",
      ]);
    })
  );
});

describe("executor check reads", () => {
  it.effect(
    "superseded workflow runs drop out and the newer run keeps its attempt",
    () =>
      Effect.gen(function* test() {
        const checks = yield* readChecks("sample/project", "car-a").pipe(
          Effect.provideService(GitHub, fake)
        );

        expect(checks).toEqual([
          {
            attempt: 2,
            conclusion: "success",
            headSha: "car-a",
            id: 3,
            name: "unit",
            runId: 20,
            status: "completed",
          },
          {
            conclusion: "success",
            headSha: "car-a",
            id: 4,
            name: "external status",
            status: "completed",
          },
        ]);
      })
  );
});
