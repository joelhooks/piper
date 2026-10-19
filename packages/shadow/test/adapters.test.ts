import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { GitHub } from "@joelhooks/piper-executor/github";
import { Effect, Exit, FileSystem, Path } from "effect";

import { captureReads } from "../src/capture.js";
import type { RawRead } from "../src/domain.js";
import { GitHubFeed } from "../src/feed.js";
import { privateDirectory } from "../src/storage.js";
import { OperatorTrace } from "../src/trace.js";

const pull = {
  base: { ref: "main", sha: "base-a" },
  body: "Cars: 1, 2",
  created_at: "2026-01-01T00:00:00Z",
  draft: true,
  head: { ref: "train/1", sha: "train-head" },
  labels: [{ name: "train" }, { name: "reviewed" }],
  merge_commit_sha: "merge-result",
  merged_at: "2026-01-01T00:10:00Z",
  node_id: "synthetic-node",
  number: 3,
  state: "closed",
  user: { login: "synthetic-author" },
};

const fake = (responses: ReadonlyMap<string, unknown>): GitHub["Service"] => ({
  read: (_repo, path) =>
    responses.has(path)
      ? Effect.succeed(responses.get(path))
      : Effect.fail(new ExecutorError({ code: "not-found", message: path })),
});

const commit = (sha: string, parents: readonly string[]) => ({
  commit: { committer: { date: "2026-01-01T00:01:00Z" } },
  parents: parents.map((parent) => ({ sha: parent })),
  sha,
});

describe("read-only adapters", () => {
  it.effect(
    "derives car order from merge parents and tested head from the merge, not current branch",
    () =>
      Effect.gen(function* test() {
        const responses = new Map<string, unknown>([
          ["/pulls/3", pull],
          [
            "/pulls/3/commits?&per_page=100&page=1",
            [
              commit("train-head", ["first-merge", "car-b"]),
              commit("first-merge", ["base-a", "car-a"]),
            ],
          ],
          ["/issues/3/timeline?&per_page=100&page=1", []],
          ["/issues/1/timeline?&per_page=100&page=1", []],
          ["/issues/2/timeline?&per_page=100&page=1", []],
          [
            "/actions/runs?head_sha=train-head&per_page=100",
            { total_count: 0, workflow_runs: [] },
          ],
          [
            "/commits/merge-result",
            commit("merge-result", ["new-main", "tested-head"]),
          ],
        ]);

        const trace = yield* OperatorTrace.use((tracePort) =>
          tracePort.read({
            base: "base-a",
            pr: 3,
            repo: "sample/project",
            since: "2026-01-01T00:00:00Z",
            train: 1,
          })
        ).pipe(
          Effect.provide(OperatorTrace.github),
          Effect.provideService(GitHub, fake(responses))
        );

        expect(
          trace.actions.find((action) => action.kind === "BuildTrain")
        ).toMatchObject({
          cars: ["car-a", "car-b"],
          head: "base-a",
          source: "github:commit-parents",
        });
        expect(
          trace.actions.find((action) => action.kind === "Merge")
        ).toMatchObject({ head: "tested-head", mergeSha: "merge-result" });
        expect(trace.acceptances).toEqual([]);
        expect(trace.complete).toBe(false);
      })
  );

  it.effect(
    "maps labelled candidates, exact-head checks and actual main ancestry",
    () =>
      Effect.gen(function* test() {
        const responses = new Map<string, unknown>([
          ["/git/ref/heads/main", { object: { sha: "base-a" } }],
          [
            "/pulls?state=open&sort=created&direction=asc&per_page=100&page=1",
            [{ ...pull, head: { ref: "feature-a", sha: "car-a" }, number: 1 }],
          ],
          [
            "/commits/car-a/check-runs?filter=latest&per_page=100&page=1",
            {
              check_runs: [
                {
                  conclusion: "success",
                  head_sha: "car-a",
                  name: "unit",
                  status: "completed",
                },
              ],
              total_count: 1,
            },
          ],
          [
            "/compare/base-a...car-a",
            { merge_base_commit: { sha: "older-main" } },
          ],
        ]);

        const events = yield* GitHubFeed.use((feed) =>
          feed.poll(
            {
              ciTimeoutMs: 60_000,
              ignoredChecks: [],
              maxCars: 3,
              pollMs: 60_000,
              repo: "sample/project",
              train: 1,
              trainLabel: "train",
            },
            1
          )
        ).pipe(
          Effect.provide(GitHubFeed.layer),
          Effect.provideService(GitHub, fake(responses))
        );

        expect(events).toMatchObject([
          {
            candidates: [
              {
                checks: [{ headSha: "car-a" }],
                headSha: "car-a",
                operatorReviewed: true,
                upToDate: false,
              },
            ],
            main: "base-a",
          },
        ]);
      })
  );

  it.effect(
    "records missing reads and pins repeated reads to one poll snapshot",
    () =>
      Effect.gen(function* test() {
        let count = 0;
        const reads: RawRead[] = [];

        const github = captureReads(
          {
            read: () =>
              Effect.sync(() => {
                count += 1;

                return { sha: `revision-${count}` };
              }),
          },
          reads
        );

        expect(yield* github.read("sample/project", "/ref")).toEqual({
          sha: "revision-1",
        });
        expect(yield* github.read("sample/project", "/ref")).toEqual({
          sha: "revision-1",
        });
        expect(count).toBe(1);
        const missing = captureReads(fake(new Map()), reads);
        expect(
          Exit.isFailure(
            yield* Effect.exit(missing.read("sample/project", "/missing"))
          )
        ).toBe(true);
        expect(reads.at(-1)).toMatchObject({ missing: true, path: "/missing" });
      })
  );

  it.effect("refuses recording anywhere inside a checkout", () =>
    Effect.gen(function* test() {
      const result = yield* Effect.exit(
        privateDirectory("packages/shadow/forbidden-recording")
      );

      expect(Exit.isFailure(result)).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists("packages/shadow/forbidden-recording")).toBe(
        false
      );
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("creates recordings with private directory permissions", () =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped();
      const directory = yield* privateDirectory(path.join(parent, "recording"));
      expect((yield* fs.stat(directory)).mode % 0o1000).toBe(0o700);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});
