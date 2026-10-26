import type { CheckRun } from "@joelhooks/piper/domain";
import { Data, Effect, Layer, Schema } from "effect";

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
    drafts: [3],
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

interface ProviderControls {
  candidateChecks: readonly CheckRun[] | undefined;
  drafts: readonly number[];
  trainChecks: readonly CheckRun[] | undefined;
}

const OpenedPull = Schema.Struct({ draft: Schema.Boolean });

const ReadyMutation = Schema.Struct({
  variables: Schema.Struct({ id: Schema.String }),
});

const nodeOf = (number: number) => `node-${number}`;

const pullOf = (path: string) => Number(path.split("/")[2]);

export const fake = (jobs: readonly Job[] = [], entries: Entry[] = []) => {
  const reads: string[] = [];
  const writes: Write[] = [];
  const records: WouldDo[] = [];
  const posted: Event[] = [];

  const provider: ProviderControls = {
    candidateChecks: undefined,
    drafts: [],
    trainChecks: undefined,
  };

  const controls = {
    ...provider,
    baseHead: BASE,
    baseline: true,
    carHead: car.headSha,
    conflict: false,
    crash: false,
    failPost: false,
    graphqlErrors: false,
    head: HEAD,
    labelMissing: false,
    mergeRefused: false,
    moveBaseAfterBuild: false,
    moveCarAfterBuild: false,
    refMissing: false,
    rerunGuardRealRed: false,
    runner: false,
    upToDate: true,
  };

  const read = Effect.fn("Fake.read")(function* read(
    _repo: string,
    path: string
  ) {
    reads.push(path);

    if (path.includes("/actions/runs?")) {
      return {
        total_count: 1,
        workflow_runs: [
          {
            check_suite_id: 10,
            created_at: "2026-01-01T00:00:00Z",
            event: "pull_request",
            id: 11,
            run_attempt: 2,
            workflow_id: 1,
          },
        ],
      };
    }

    if (path.includes("/check-runs?")) {
      const head = decodeURIComponent(path.split("/")[2] ?? HEAD);

      const configured =
        head === car.headSha ? controls.candidateChecks : controls.trainChecks;

      if (configured !== undefined) {
        return {
          check_runs: configured.map((check) => ({
            ...check,
            check_suite: { id: 10 },
            conclusion:
              controls.rerunGuardRealRed &&
              head !== car.headSha &&
              reads.filter((entry) => entry === path).length > 1
                ? "failure"
                : check.conclusion,
            head_sha: head,
          })),
          total_count: configured.length,
        };
      }

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

    if (path.startsWith("/compare/")) {
      return {
        merge_base_commit: {
          sha: controls.upToDate ? controls.baseHead : "old-base",
        },
      };
    }

    if (path.startsWith("/pulls/")) {
      const number = pullOf(path);

      const head =
        controls.runner && number === car.number
          ? controls.carHead
          : controls.head;

      return {
        draft: controls.drafts.includes(number),
        head: { sha: head },
        labels: [],
        mergeable: true,
        node_id: nodeOf(number),
        number,
        user: { login: car.owner },
      };
    }

    if (path === "/git/ref/heads/trunk") {
      return { object: { sha: controls.baseHead } };
    }

    if (path.startsWith("/git/ref/")) {
      return controls.refMissing
        ? yield* new ExecutorError({
            code: "not-found",
            message: "synthetic missing ref",
          })
        : { object: { sha: controls.head } };
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

    if (
      controls.labelMissing &&
      operation.path.startsWith("/issues/1/labels/")
    ) {
      return yield* new ExecutorError({
        code: "not-found",
        message: "synthetic absent label",
      });
    }

    if (operation.path === "/merges") {
      if (controls.conflict) {
        return yield* new ExecutorError({
          code: "head-mismatch",
          message: "synthetic conflict",
        });
      }

      if (controls.runner) {
        controls.head = "built-a";

        if (controls.moveBaseAfterBuild) {
          controls.baseHead = "base-b";
        }

        if (controls.moveCarAfterBuild) {
          controls.carHead = "car-b";
        }
      }

      return { sha: "built-a" };
    }

    if (operation.path.endsWith("/merge")) {
      if (controls.drafts.includes(pullOf(operation.path))) {
        return yield* new ExecutorError({
          code: "provider",
          message: "Provider returned HTTP 405",
        });
      }

      return {
        merged: !controls.mergeRefused,
        message: "synthetic merge",
        sha: "merged-a",
      };
    }

    if (controls.runner && operation.path.endsWith("/rerun-failed-jobs")) {
      controls.trainChecks = undefined;
    }

    if (operation.path === "/pulls") {
      const opened = yield* Schema.decodeUnknownEffect(OpenedPull)(
        operation.body
      ).pipe(Effect.orDie);

      if (opened.draft) {
        controls.drafts = [...controls.drafts, 3];
      }

      return { head: { sha: HEAD }, node_id: nodeOf(3), number: 3 };
    }

    if (operation.path === "/graphql") {
      if (controls.graphqlErrors) {
        return {
          data: null,
          errors: [{ message: "Resource not accessible by integration" }],
        };
      }

      const { id } = (yield* Schema.decodeUnknownEffect(ReadyMutation)(
        operation.body
      ).pipe(Effect.orDie)).variables;

      controls.drafts = controls.drafts.filter(
        (number) => nodeOf(number) !== id
      );

      return {
        data: { markPullRequestReadyForReview: { pullRequest: { id } } },
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
