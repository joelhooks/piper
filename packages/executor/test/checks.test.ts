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
