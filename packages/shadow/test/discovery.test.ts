import { describe, expect, it } from "@effect/vitest";
import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { GitHub } from "@joelhooks/piper-executor/github";
import { Effect } from "effect";

import { discoverTrains } from "../src/capture.js";

const pull = (number: number, ref: string, createdAt: string) => ({
  base: { ref: "main", sha: "base" },
  body: null,
  created_at: createdAt,
  draft: false,
  head: { ref, sha: `head-${number}` },
  labels: [],
  merge_commit_sha: null,
  merged_at: null,
  node_id: `node-${number}`,
  number,
  state: "open",
  user: { login: "synthetic-author" },
});

const page = (from: number, createdAt: (number: number) => string) =>
  Array.from({ length: 100 }, (_, index) => {
    const number = from - index;

    return pull(
      number,
      number % 50 === 0 ? `train/${number}` : `topic/${number}`,
      createdAt(number)
    );
  });

const time = (number: number) =>
  number > 1950 ? "2026-01-02T00:00:00Z" : "2026-01-01T00:00:00Z";

const path = (index: number) =>
  `/pulls?state=all&sort=created&direction=desc&per_page=100&page=${index}`;

const recorded = (
  responses: ReadonlyMap<string, unknown>,
  reads: string[]
): GitHub["Service"] => ({
  read: (_repo, requested) => {
    reads.push(requested);

    return responses.has(requested)
      ? Effect.succeed(responses.get(requested))
      : Effect.fail(
          new ExecutorError({ code: "not-found", message: requested })
        );
  },
});

describe("train discovery", () => {
  it.effect(
    "reads newest pulls first and stops at the page that crosses since",
    () =>
      Effect.gen(function* test() {
        const reads: string[] = [];

        const responses = new Map<string, unknown>([
          [path(1), page(2000, time)],
          [path(2), page(1900, time)],
        ]);

        const trains = yield* discoverTrains(
          "sample/project",
          "2026-01-01T12:00:00Z"
        ).pipe(Effect.provideService(GitHub, recorded(responses, reads)));

        expect(reads).toEqual([path(1)]);
        expect(trains.map((train) => train.train)).toEqual([2000]);
      })
  );

  it.effect("refuses more than ten recent pages", () =>
    Effect.gen(function* test() {
      const reads: string[] = [];

      const responses = new Map<string, unknown>(
        Array.from({ length: 10 }, (_, index) => [
          path(index + 1),
          page(5000 - index * 100, () => "2026-01-02T00:00:00Z"),
        ])
      );

      const error = yield* Effect.flip(
        discoverTrains("sample/project", "2026-01-01T00:00:00Z").pipe(
          Effect.provideService(GitHub, recorded(responses, reads))
        )
      );

      expect(reads).toHaveLength(10);
      expect(error.message).toContain("ten pages");
    })
  );
});
