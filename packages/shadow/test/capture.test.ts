import { describe, expect, it } from "@effect/vitest";
import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { GitHub } from "@joelhooks/piper-executor/github";
import type { PostedEvent } from "@joelhooks/piper/domain";
import { Data, Effect } from "effect";

import { capturePoll, captureReads } from "../src/capture.js";
import type { ActionValues, RawRead, Recording, Trace } from "../src/domain.js";
import { GitHubFeed } from "../src/feed.js";
import { runRecording } from "../src/runner.js";
import { OperatorTrace } from "../src/trace.js";

const posted = Data.taggedEnum<PostedEvent>();

const start = Date.parse("2026-01-01T00:00:00Z");

const times = [start, start + 60_000, start + 180_000];

const initial: Recording = {
  frames: [],
  input: {
    ciTimeoutMs: 1_800_000,
    ignoredChecks: [],
    maxCars: 1,
    pollMs: 60_000,
    repo: "sample/project",
    train: 1,
    trainLabel: "train",
  },
  since: "2026-01-01T00:00:00Z",
  trace: { acceptances: [], actions: [], complete: false },
  version: 1,
};

const trainPull = {
  base: { ref: "main", sha: "main-a" },
  body: "Cars: 1",
  created_at: initial.since,
  draft: true,
  head: { ref: "train/1", sha: "train-head" },
  labels: [],
  merge_commit_sha: null,
  merged_at: null,
  node_id: "synthetic-train",
  number: 2,
  state: "open",
  user: { login: "synthetic-operator" },
};

const expected: ActionValues[] = [
  { cars: ["car-a"], head: "main-a", kind: "BuildTrain", members: [1] },
  { cars: ["car-a"], head: "train-head", kind: "OpenTrainPr", members: [1] },
  { head: "train-head", kind: "MarkReady", prs: [2] },
  { head: "train-head", kind: "Merge", prs: [2] },
  { head: "train-head", kind: "RemoveLabels", label: "train", prs: [1, 2] },
];

const responses = new Map<string, unknown>([
  ["/git/ref/heads/train%2F1", { object: { sha: "train-head" } }],
  ["/pulls/2", trainPull],
  [
    "/commits/car-a/pulls",
    [{ ...trainPull, head: { ref: "topic/a", sha: "car-a" }, number: 1 }],
  ],
  [
    "/actions/runs?head_sha=train-head&per_page=100",
    { total_count: 0, workflow_runs: [] },
  ],
  [
    "/commits/train-head/check-runs?filter=latest&per_page=100&page=1",
    {
      check_runs: [
        {
          conclusion: "success",
          head_sha: "train-head",
          name: "unit",
          status: "completed",
        },
      ],
      total_count: 1,
    },
  ],
]);

const github = (values: ReadonlyMap<string, unknown>): GitHub["Service"] => ({
  read: (_repo, path) =>
    values.has(path)
      ? Effect.succeed(values.get(path))
      : Effect.fail(
          new ExecutorError({
            code: "decode",
            message: `Unexpected read: ${path}`,
          })
        ),
});

const traceAt = (index: number): Trace => ({
  acceptances:
    index < 2
      ? []
      : [
          {
            fact: {
              at: start + 180_000,
              by: "synthetic-operator",
              kind: "operator-acceptance",
              nodes: ["slice-a"],
            },
            head: "train-head",
          },
        ],
  actions: expected
    .filter((action) => action.kind !== "MarkReady")
    .slice(0, index * 2)
    .map((action, slot) => ({
      ...action,
      at: start + slot * 1000,
      slot,
      source: "synthetic:operator-log",
      ...(action.kind === "Merge" ? { mergeSha: "merged-head" } : undefined),
    })),
  complete: index === 2,
});

const feed: GitHubFeed["Service"] = {
  poll: (_input, at) =>
    Effect.succeed([
      posted.candidates({
        at,
        candidates: [
          {
            checks: [
              {
                conclusion: "success",
                headSha: "car-a",
                name: "unit",
                status: "completed",
              },
            ],
            headSha: "car-a",
            labels: ["train"],
            number: 1,
            operatorReviewed: true,
            owner: "synthetic-author",
            upToDate: true,
          },
        ],
        main: at === start + 180_000 ? "merged-head" : "main-a",
      }),
    ]),
};

const scenario = Effect.fn("Test.captureScenario")(function* scenario({
  autoGo,
  provider = github(responses),
  supplied = [],
}: {
  readonly autoGo?: { readonly by: string };
  readonly provider?: GitHub["Service"];
  readonly supplied?: readonly PostedEvent[];
} = {}) {
  let recording = initial;

  for (const [index, at] of times.entries()) {
    const reads: RawRead[] = [];

    const captured = yield* capturePoll(
      recording,
      2,
      at,
      index === 2 ? supplied : [],
      reads,
      { autoGo }
    ).pipe(
      Effect.provideService(GitHub, captureReads(provider, reads)),
      Effect.provideService(GitHubFeed, feed),
      Effect.provideService(OperatorTrace, {
        read: () => Effect.succeed(traceAt(index)),
      })
    );

    if (index === 0) {
      expect(
        captured.recording.frames.at(-1)?.events.map((event) => event._tag)
      ).toEqual(["candidates", "depart"]);
    }

    if (index === 1) {
      expect(captured.report.expected).toEqual(expected.slice(0, 2));
      expect(
        captured.recording.frames.at(-1)?.events.map((event) => event._tag)
      ).toEqual(["candidates", "built", "tick"]);
    }

    expect(yield* runRecording(captured.recording)).toEqual(captured.report);
    ({ recording } = captured);
  }

  return { recording, report: yield* runRecording(recording) };
});

describe("capture poll ordering", () => {
  it.effect(
    "auto GO predicts a merge before the same poll observes main moving",
    () =>
      Effect.gen(function* test() {
        const { recording, report } = yield* scenario({
          autoGo: { by: "synthetic-operator" },
        });

        expect(report.expected).toEqual(expected);
        expect(report.comparison).toMatchObject({
          differences: [],
          status: "match",
        });
        expect(report.view.state).toBe("landed");
        expect(
          recording.frames.at(-1)?.events.map((event) => event._tag)
        ).toEqual([
          "candidates",
          "prOpened",
          "tick",
          "go",
          "mainMoved",
          "merged",
        ]);
      })
  );

  it.effect("capture does not predict a merge without opt-in GO", () =>
    Effect.gen(function* test() {
      const { recording, report } = yield* scenario();
      expect(report.expected.some((action) => action.kind === "Merge")).toBe(
        false
      );
      expect(report.comparison.pending).toContain("no predicted merge");
      expect(
        recording.frames.at(-1)?.events.map((event) => event._tag)
      ).toEqual(["candidates", "prOpened", "tick", "mainMoved", "merged"]);
    })
  );

  it.effect(
    "auto GO is recorded even when checks are pending but cannot merge",
    () =>
      Effect.gen(function* test() {
        const pending = new Map<string, unknown>([
          ...responses,
          [
            "/commits/train-head/check-runs?filter=latest&per_page=100&page=1",
            {
              check_runs: [
                {
                  conclusion: null,
                  head_sha: "train-head",
                  name: "unit",
                  status: "in_progress",
                },
              ],
              total_count: 1,
            },
          ],
        ]);

        const { recording, report } = yield* scenario({
          autoGo: { by: "synthetic-operator" },
          provider: github(pending),
        });

        expect(report.expected.some((action) => action.kind === "Merge")).toBe(
          false
        );
        expect(recording.frames.at(-1)?.events).toContainEqual(
          posted.go({
            at: start + 180_000,
            by: "synthetic-operator",
            head: "train-head",
          })
        );
      })
  );

  it.effect("supplied GO follows checks and precedes main movement", () =>
    Effect.gen(function* test() {
      const { report } = yield* scenario({
        supplied: [
          posted.go({
            at: start + 180_000,
            by: "synthetic-operator",
            head: "train-head",
          }),
        ],
      });

      expect(report.expected).toEqual(expected);
      expect(report.comparison.status).toBe("match");
    })
  );
});
