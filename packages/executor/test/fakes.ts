import { Data, Effect, Layer } from "effect";

import { ExecutorError } from "../src/domain.js";
import type { Event, Job, WouldDo, Write } from "../src/domain.js";
import { Judge } from "../src/execute.js";
import { GitHub } from "../src/github.js";
import { Journal } from "../src/journal.js";
import type { Entry } from "../src/journal.js";
import { Recorder } from "../src/recorder.js";
import type { Settings } from "../src/services.js";
import { Outbox } from "../src/worker.js";
import { GitHubWrites } from "../src/writes.js";

export const HEAD = "head-a";

export const BASE = "base-a";

export const car = { headSha: "car-a", number: 1, owner: "author-a" };

export const dry = {
  baseBranch: "main",
  baselineWorkflows: { unit: "unit.yml" },
  mode: "dry-run",
} satisfies Settings;

export const live = { ...dry, mode: "live" } satisfies Settings;

const jobValues = Data.taggedEnum<Job>();

export const train = (
  intent: Extract<Job, { readonly _tag: "train" }>["intent"]
): Job =>
  jobValues.train({
    head: HEAD,
    intent,
    repo: "sample/project",
    target: "/trains/1",
  });

export const solo = (
  intent: Extract<Job, { readonly _tag: "solo" }>["intent"]
): Job =>
  jobValues.solo({
    head: HEAD,
    intent,
    repo: "sample/project",
    target: "/solos/pr-1%40head-a",
  });

const stamp = { at: 1, id: "train-1/1" };

export const cases = [
  {
    events: ["built"],
    job: train({
      ...stamp,
      base: BASE,
      branch: "train/1",
      buildId: 1,
      cars: [car],
      kind: "BuildTrain",
      purpose: "train",
    }),
    paths: ["PATCH /git/refs/heads/train%2F1", "POST /merges"],
  },
  {
    events: ["prOpened"],
    job: train({
      ...stamp,
      base: BASE,
      branch: "train/1",
      cars: [car],
      kind: "OpenTrainPr",
    }),
    paths: ["POST /pulls"],
  },
  {
    events: ["checks"],
    job: train({ ...stamp, head: HEAD, kind: "PollChecks" }),
    paths: [],
  },
  {
    events: ["rankFailed"],
    job: train({
      ...stamp,
      cars: [car],
      failing: [],
      head: HEAD,
      kind: "RankSuspects",
    }),
    paths: [],
  },
  {
    events: [],
    job: train({ ...stamp, head: HEAD, kind: "RerunChecks" }),
    paths: ["POST /actions/runs/11/rerun-failed-jobs"],
  },
  {
    events: [],
    job: train({ ...stamp, kind: "MarkReady", pr: 3 }),
    paths: ["POST /graphql"],
  },
  {
    events: ["merged"],
    job: train({ ...stamp, kind: "Merge", matchHead: HEAD, pr: 3 }),
    paths: ["PUT /pulls/3/merge"],
  },
  {
    events: [],
    job: train({ ...stamp, kind: "RemoveLabels", label: "train", prs: [1, 3] }),
    paths: ["DELETE /issues/1/labels/train", "DELETE /issues/3/labels/train"],
  },
  {
    events: [],
    job: train({
      ...stamp,
      car,
      excerpt: "synthetic failure",
      kind: "NotifyOwner",
      reason: "culprit",
    }),
    paths: ["POST /issues/1/comments"],
  },
  {
    events: [],
    job: train({ ...stamp, kind: "CloseTrainPr", pr: 3, reason: "superseded" }),
    paths: ["PATCH /pulls/3"],
  },
  {
    events: [],
    job: solo({
      ...stamp,
      checkRunIds: [12],
      checks: ["unit"],
      head: HEAD,
      kind: "RerunFailed",
      pr: 1,
      workflowRunIds: [11],
    }),
    paths: ["POST /actions/runs/11/rerun-failed-jobs"],
  },
  {
    events: ["checks"],
    job: solo({
      ...stamp,
      checks: ["unit"],
      kind: "PollChecks",
      pr: 1,
      sha: HEAD,
    }),
    paths: [],
  },
  {
    events: ["baseline"],
    job: solo({
      ...stamp,
      base: BASE,
      checks: ["unit"],
      kind: "RunBaseline",
      pr: 1,
    }),
    paths: [],
  },
  {
    events: [],
    job: solo({
      ...stamp,
      excerpt: "synthetic regression",
      head: HEAD,
      kind: "NotifyOwner",
      owner: "author-a",
      pr: 1,
      reason: "regression",
    }),
    paths: ["POST /issues/1/comments"],
  },
  {
    events: [],
    job: solo({
      ...stamp,
      detail: "synthetic timeout",
      head: HEAD,
      kind: "NotifyOperator",
      outcome: "unknown",
      pr: 1,
    }),
    paths: ["POST /issues/1/comments"],
  },
];

export const fake = (jobs: readonly Job[] = [], entries: Entry[] = []) => {
  const reads: string[] = [];
  const writes: Write[] = [];
  const records: WouldDo[] = [];
  const posted: Event[] = [];

  const controls = {
    baseline: true,
    conflict: false,
    crash: false,
    failPost: false,
    head: HEAD,
  };

  const read = Effect.fn("Fake.read")(function* read(
    _repo: string,
    path: string
  ) {
    reads.push(path);

    if (path.includes("/actions/runs?")) {
      return {
        total_count: 1,
        workflow_runs: [{ check_suite_id: 10, id: 11, run_attempt: 2 }],
      };
    }

    if (path.includes("/check-runs?")) {
      const head = decodeURIComponent(path.split("/")[2] ?? HEAD);

      return {
        check_runs:
          controls.baseline || head !== BASE
            ? [
                {
                  check_suite: { id: 10 },
                  conclusion: "success",
                  head_sha: head,
                  id: 12,
                  name: "unit",
                  status: "completed",
                },
              ]
            : [],
        total_count: controls.baseline || head !== BASE ? 1 : 0,
      };
    }

    if (path.startsWith("/pulls/")) {
      return { head: { sha: controls.head }, node_id: "node-3", number: 3 };
    }

    if (path.startsWith("/git/ref/")) {
      return { object: { sha: HEAD } };
    }

    return yield* new ExecutorError({
      code: "provider",
      message: "Unexpected fake read",
    });
  });

  const write = Effect.fn("Fake.write")(function* write(
    _job: Job,
    operation: Write
  ) {
    writes.push(operation);

    if (controls.crash) {
      return yield* Effect.die("synthetic crash after provider accepted");
    }

    if (operation.path === "/merges") {
      if (controls.conflict) {
        return yield* new ExecutorError({
          code: "head-mismatch",
          message: "synthetic conflict",
        });
      }

      return { sha: "built-a" };
    }

    if (operation.path.endsWith("/merge")) {
      return { merged: true, message: "synthetic merge", sha: "merged-a" };
    }

    if (operation.path === "/pulls") {
      return { head: { sha: HEAD }, node_id: "node-3", number: 3 };
    }

    if (operation.path === "/graphql") {
      return {
        data: {
          markPullRequestReadyForReview: { pullRequest: { id: "node-3" } },
        },
      };
    }

    return null;
  });

  const layer = Layer.mergeAll(
    Layer.succeed(GitHub, { read }),
    Layer.succeed(GitHubWrites, { write }),
    Layer.succeed(Recorder, {
      append: (record) =>
        Effect.sync(() => {
          records.push(record);
        }),
    }),
    Layer.succeed(Journal, {
      append: (entry) =>
        Effect.sync(() => {
          entries.push(entry);
        }),
      entries: Effect.sync(() => [...entries]),
    }),
    Layer.succeed(Outbox, {
      post: (_job, events) =>
        controls.failPost
          ? Effect.fail(
              new ExecutorError({
                code: "transport",
                message: "synthetic ambiguous response",
              })
            )
          : Effect.sync(() => {
              posted.push(...events);
            }),
      read: Effect.succeed(jobs),
    }),
    Judge.absent
  );

  return { controls, entries, layer, posted, reads, records, writes };
};
