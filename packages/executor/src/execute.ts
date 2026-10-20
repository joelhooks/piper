import type { RankSchema, JudgeSchema } from "@joelhooks/piper/domain";
import { CheckRunSchema } from "@joelhooks/piper/domain";
import { Clock, Context, Data, Effect, Layer, Predicate, Schema } from "effect";

import { decode } from "./boundary.js";
import { ExecutorError } from "./domain.js";
import type { Event, Job, Outcome, Write } from "./domain.js";
import { GitHub } from "./github.js";
import { Recorder } from "./recorder.js";
import { executeRelease } from "./release.js";
import type { Settings } from "./services.js";
import { GitHubWrites } from "./writes.js";

const MarkedReady = Schema.Struct({
  data: Schema.Struct({
    markPullRequestReadyForReview: Schema.Struct({
      pullRequest: Schema.Struct({ id: Schema.String }),
    }),
  }),
});

const GraphQlErrors = Schema.Struct({
  errors: Schema.NonEmptyArray(Schema.Struct({ message: Schema.String })),
});

const events = Data.taggedEnum<Event>();

export class Judge extends Context.Service<
  Judge,
  {
    readonly rank: (job: Job) => Effect.Effect<
      {
        readonly judge: typeof JudgeSchema.Type;
        readonly ranks: readonly (typeof RankSchema.Type)[];
      },
      ExecutorError
    >;
  }
>()("piper-executor/Judge") {
  static readonly absent = Layer.succeed(Judge, {
    rank: () =>
      Effect.fail(
        new ExecutorError({
          code: "configuration",
          message: "No advisory judge configured",
        })
      ),
  });
}

const ShaResponse = Schema.Struct({ sha: Schema.NonEmptyString });

const Pull = Schema.Struct({
  head: ShaResponse,
  node_id: Schema.String,
  number: Schema.Int,
});

const Ref = Schema.Struct({ object: ShaResponse });

const ApiCheck = Schema.Struct({
  ...CheckRunSchema.fields,
  check_suite: Schema.optionalKey(Schema.Struct({ id: Schema.Int })),
  headSha: Schema.optionalKey(Schema.String),
  head_sha: Schema.String,
});

const ApiChecks = Schema.Struct({
  check_runs: Schema.Array(ApiCheck),
  total_count: Schema.Int,
});

const ApiRuns = Schema.Struct({
  total_count: Schema.Int,
  workflow_runs: Schema.Array(
    Schema.Struct({
      check_suite_id: Schema.Int,
      id: Schema.Int,
      run_attempt: Schema.Int,
    })
  ),
});

export const readChecks = Effect.fn("Executor.checks")(function* readChecks(
  repo: string,
  head: string
) {
  const github = yield* GitHub;
  const checks: (typeof CheckRunSchema.Type)[] = [];
  let page = 1;
  let total = 1;

  const runs = yield* decode(ApiRuns)(
    yield* github.read(
      repo,
      `/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=100`
    )
  );

  if (runs.total_count > 100) {
    return yield* new ExecutorError({
      code: "provider",
      message:
        "Workflow run read exceeds bound; refusing incomplete observation",
    });
  }

  while (checks.length < total && page <= 10) {
    const batch = yield* decode(ApiChecks)(
      yield* github.read(
        repo,
        `/commits/${encodeURIComponent(head)}/check-runs?filter=latest&per_page=100&page=${page}`
      )
    );

    total = batch.total_count;

    if (batch.check_runs.length === 0 && checks.length < total) {
      return yield* new ExecutorError({
        code: "provider",
        message: "Check pagination is incomplete",
      });
    }

    for (const check of batch.check_runs) {
      if (check.head_sha !== head) {
        return yield* new ExecutorError({
          code: "head-mismatch",
          message: "Checks belong to another head",
        });
      }

      const run = runs.workflow_runs.find(
        (item) => item.check_suite_id === check.check_suite?.id
      );

      const observation = {
        conclusion: check.conclusion,
        headSha: head,
        name: check.name,
        status: check.status,
      };

      const attempted =
        run === undefined
          ? observation
          : { ...observation, attempt: run.run_attempt, runId: run.id };

      checks.push(
        check.id === undefined ? attempted : { ...attempted, id: check.id }
      );
    }

    page += 1;
  }

  if (checks.length < total) {
    return yield* new ExecutorError({
      code: "provider",
      message: "Check read exceeds pagination bound",
    });
  }

  return checks;
});

const write = (
  method: Write["method"],
  path: string,
  body: Write["body"] = null
): Write => ({ body, method, path });

const effectiveHead = (job: Job) => {
  const { intent } = job;

  if ("matchHead" in intent) {
    return intent.matchHead;
  }

  if ("head" in intent) {
    return intent.head;
  }

  if ("sha" in intent) {
    return intent.sha;
  }

  if ("base" in intent && intent.kind !== "OpenTrainPr") {
    return intent.base;
  }

  return job.head;
};

const apply = Effect.fn("Executor.apply")(function* apply(
  job: Job,
  operations: readonly Write[],
  settings: Settings
) {
  if (settings.mode === "dry-run") {
    const recorder = yield* Recorder;
    yield* recorder.append({
      head: effectiveHead(job),
      intentId: job.intent.id,
      kind: job.intent.kind,
      repo: job.repo,
      wouldDo: operations,
    });

    return [];
  }

  const github = yield* GitHubWrites;
  const results: unknown[] = [];

  for (const operation of operations) {
    results.push(yield* github.write(job, operation));
  }

  return results;
});

const result = (posted: readonly Event[] = []): Outcome => ({
  events: posted,
  status: "done",
});

const applied = (
  settings: Settings,
  posted: readonly Event[] = []
): Outcome => ({
  events: posted,
  status: settings.mode === "dry-run" ? "recorded-would-do" : "done",
});

const build = Effect.fn("Executor.build")(function* build(
  job: Job,
  intent: Extract<Job["intent"], { readonly kind: "BuildTrain" }>,
  settings: Settings
) {
  if (!/^train\/[1-9][0-9]*$/u.test(intent.branch)) {
    return yield* new ExecutorError({
      code: "configuration",
      message: "Train writes require the reserved train/<number> namespace",
    });
  }

  const github = yield* GitHub;
  const at = yield* Clock.currentTimeMillis;

  const existing = yield* github
    .read(job.repo, `/git/ref/heads/${encodeURIComponent(intent.branch)}`)
    .pipe(
      Effect.flatMap(decode(Ref)),
      Effect.map((ref) => ref.object.sha),
      Effect.catchIf(
        (error) => error.code === "not-found",
        () => Effect.void
      )
    );

  const refOperation =
    existing === undefined
      ? write("POST", "/git/refs", {
          ref: `refs/heads/${intent.branch}`,
          sha: intent.base,
        })
      : write("PATCH", `/git/refs/heads/${encodeURIComponent(intent.branch)}`, {
          force: true,
          sha: intent.base,
        });

  const operations = [
    refOperation,
    ...intent.cars.map((car) =>
      write("POST", "/merges", {
        base: intent.branch,
        commit_message: `Train car ${car.number}`,
        head: car.headSha,
      })
    ),
  ];

  if (settings.mode === "dry-run") {
    yield* apply(job, operations, settings);

    return applied(settings);
  }

  const writer = yield* GitHubWrites;
  yield* writer.write(job, refOperation);
  let head = intent.base;
  const merged: number[] = [];
  const conflicted: number[] = [];

  for (const car of intent.cars) {
    const previous = head;

    const mergedHead = yield* writer
      .write(
        job,
        write("POST", "/merges", {
          base: intent.branch,
          commit_message: `Train car ${car.number}`,
          head: car.headSha,
        })
      )
      .pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.succeed(previous)
            : decode(ShaResponse)(value).pipe(
                Effect.map((response) => response.sha)
              )
        ),
        Effect.catchIf(
          (error) => error.code === "head-mismatch",
          () => Effect.void
        )
      );

    if (mergedHead === undefined) {
      conflicted.push(car.number);
    } else {
      merged.push(car.number);
      head = mergedHead;
    }
  }

  return result([
    events.built({ at, buildId: intent.buildId, conflicted, head, merged }),
  ]);
});

const executeTrain = Effect.fn("Executor.train")(function* executeTrain(
  job: Extract<Job, { readonly _tag: "train" }>,
  settings: Settings
): Effect.fn.Return<
  Outcome,
  ExecutorError,
  GitHub | GitHubWrites | Recorder | Judge
> {
  const github = yield* GitHub;
  const at = yield* Clock.currentTimeMillis;
  const { intent } = job;

  switch (intent.kind) {
    case "PollChecks": {
      return result([
        events.checks({
          at,
          checks: yield* readChecks(job.repo, intent.head),
          head: intent.head,
        }),
      ]);
    }

    case "RankSuspects": {
      const judge = yield* Judge;

      return yield* judge.rank(job).pipe(
        Effect.map((ranking) =>
          result([events.ranked({ at, head: intent.head, ...ranking })])
        ),
        Effect.catch((error) =>
          Effect.succeed(
            result([
              events.rankFailed({
                at,
                head: intent.head,
                reason: error.message,
              }),
            ])
          )
        )
      );
    }

    case "BuildTrain": {
      return yield* build(job, intent, settings);
    }

    case "OpenTrainPr": {
      if (settings.mode === "live") {
        const refs = yield* decode(Ref)(
          yield* github.read(
            job.repo,
            `/git/ref/heads/${encodeURIComponent(intent.branch)}`
          )
        );

        if (refs.object.sha !== job.head) {
          return yield* new ExecutorError({
            code: "head-mismatch",
            message: "Train branch changed before opening PR",
          });
        }
      }

      const responses = yield* apply(
        job,
        [
          write("POST", "/pulls", {
            base: settings.baseBranch,
            body: `Cars: ${intent.cars.map((car) => car.number).join(", ")}`,
            draft: true,
            head: intent.branch,
            title: `Train ${intent.branch}`,
          }),
        ],
        settings
      );

      if (settings.mode === "dry-run") {
        return applied(settings);
      }

      const pull = yield* decode(Pull)(responses[0]);

      return result([events.prOpened({ at, pr: pull.number })]);
    }

    case "RerunChecks": {
      const checks = yield* readChecks(job.repo, intent.head);

      const ids = [
        ...new Set(
          checks.flatMap((check) =>
            check.runId === undefined ? [] : [check.runId]
          )
        ),
      ];

      if (ids.length === 0) {
        return yield* new ExecutorError({
          code: "provider",
          message: "No workflow run IDs found for rerun",
        });
      }

      yield* apply(
        job,
        ids.map((id) => write("POST", `/actions/runs/${id}/rerun-failed-jobs`)),
        settings
      );

      return applied(settings);
    }

    case "MarkReady": {
      const pull = yield* decode(Pull)(
        yield* github.read(job.repo, `/pulls/${intent.pr}`)
      );

      if (pull.head.sha !== job.head) {
        return yield* new ExecutorError({
          code: "head-mismatch",
          message: "PR head changed before ready",
        });
      }

      const responses = yield* apply(
        job,
        [
          write("POST", "/graphql", {
            query:
              "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id}}}",
            variables: { id: pull.node_id },
          }),
        ],
        settings
      );

      if (settings.mode === "live") {
        yield* decode(MarkedReady)(responses[0]).pipe(
          Effect.catchTag("ExecutorError", (error) =>
            Schema.decodeUnknownEffect(GraphQlErrors)(responses[0]).pipe(
              Effect.mapError(() => error),
              Effect.flatMap(({ errors }) =>
                Effect.fail(
                  new ExecutorError({
                    code: "provider",
                    message: `GraphQL errors: ${errors.map((item) => item.message).join("; ")}`,
                  })
                )
              )
            )
          )
        );
      }

      return applied(settings);
    }

    case "Merge": {
      const pull = yield* decode(Pull)(
        yield* github.read(job.repo, `/pulls/${intent.pr}`)
      );

      if (pull.head.sha !== intent.matchHead) {
        return result([
          events.mergeRefused({
            at,
            head: intent.matchHead,
            reason: "PR head does not match tested head",
          }),
        ]);
      }

      return yield* apply(
        job,
        [
          write("PUT", `/pulls/${intent.pr}/merge`, {
            merge_method: "merge",
            sha: intent.matchHead,
          }),
        ],
        settings
      ).pipe(
        Effect.flatMap((responses) =>
          settings.mode === "dry-run"
            ? Effect.succeed(applied(settings))
            : decode(
                Schema.Struct({
                  merged: Schema.Boolean,
                  message: Schema.String,
                  sha: Schema.String,
                })
              )(responses[0]).pipe(
                Effect.map((response) =>
                  response.merged
                    ? result([
                        events.merged({
                          at,
                          head: intent.matchHead,
                          mergeSha: response.sha,
                        }),
                      ])
                    : result([
                        events.mergeRefused({
                          at,
                          head: intent.matchHead,
                          reason: response.message,
                        }),
                      ])
                )
              )
        ),
        Effect.catch((error) =>
          error.code === "head-mismatch"
            ? Effect.succeed(
                result([
                  events.mergeRefused({
                    at,
                    head: intent.matchHead,
                    reason: error.message,
                  }),
                ])
              )
            : Effect.fail(error)
        )
      );
    }

    case "RemoveLabels": {
      const removals = intent.prs.map((pr) =>
        write(
          "DELETE",
          `/issues/${pr}/labels/${encodeURIComponent(intent.label)}`
        )
      );

      if (settings.mode === "dry-run") {
        yield* apply(job, removals, settings);

        return applied(settings);
      }

      const writer = yield* GitHubWrites;

      yield* Effect.forEach(
        removals,
        (removal) =>
          writer.write(job, removal).pipe(
            Effect.catchIf(
              (error) => error.code === "not-found",
              () => Effect.void
            )
          ),
        { discard: true }
      );

      return result();
    }

    case "NotifyOwner": {
      yield* apply(
        job,
        [
          write("POST", `/issues/${intent.car.number}/comments`, {
            body: `@${intent.car.owner}: ${intent.reason}\n${intent.excerpt}`,
          }),
        ],
        settings
      );

      return applied(settings);
    }

    case "CloseTrainPr": {
      yield* apply(
        job,
        [write("PATCH", `/pulls/${intent.pr}`, { state: "closed" })],
        settings
      );

      return applied(settings);
    }

    default: {
      return yield* Effect.die(intent satisfies never);
    }
  }
});

const executeSolo = Effect.fn("Executor.solo")(function* executeSolo(
  job: Extract<Job, { readonly _tag: "solo" }>,
  settings: Settings
) {
  const at = yield* Clock.currentTimeMillis;
  const { intent } = job;

  switch (intent.kind) {
    case "PollChecks": {
      const checks = (yield* readChecks(job.repo, intent.sha)).filter((check) =>
        intent.checks.includes(check.name)
      );

      return result(
        intent.sha === job.head
          ? [events.checks({ at, checks, head: intent.sha })]
          : [events.baseline({ at, base: intent.sha, checks })]
      );
    }

    case "RerunFailed": {
      const operations =
        intent.workflowRunIds.length > 0
          ? [...new Set(intent.workflowRunIds)].map((id) =>
              write("POST", `/actions/runs/${id}/rerun-failed-jobs`)
            )
          : [...new Set(intent.checkRunIds)].map((id) =>
              write("POST", `/check-runs/${id}/rerequest`)
            );

      if (operations.length === 0) {
        return yield* new ExecutorError({
          code: "configuration",
          message: "Rerun has no provider IDs",
        });
      }

      yield* apply(job, operations, settings);

      return applied(settings);
    }

    case "RunBaseline": {
      const checks = (yield* readChecks(job.repo, intent.base)).filter(
        (check) => intent.checks.includes(check.name)
      );

      if (
        intent.checks.every((name) =>
          checks.some(
            (check) => check.name === name && check.status === "completed"
          )
        )
      ) {
        return result([events.baseline({ at, base: intent.base, checks })]);
      }

      const workflows = intent.checks.map(
        (name) => settings.baselineWorkflows[name]
      );

      if (workflows.some((workflow) => workflow === undefined)) {
        return yield* new ExecutorError({
          code: "configuration",
          message: "Missing baseline workflow mapping",
        });
      }

      const branch = `piper-baseline/${encodeURIComponent(intent.id)}`;
      yield* apply(
        job,
        [
          write("POST", "/git/refs", {
            ref: `refs/heads/${branch}`,
            sha: intent.base,
          }),
          ...[...new Set(workflows)].map((workflow) =>
            write(
              "POST",
              `/actions/workflows/${encodeURIComponent(workflow ?? "")}/dispatches`,
              { ref: branch }
            )
          ),
        ],
        settings
      );

      return applied(settings);
    }

    case "NotifyOwner": {
      yield* apply(
        job,
        [
          write("POST", `/issues/${intent.pr}/comments`, {
            body: `@${intent.owner}: ${intent.reason}\n${intent.excerpt}`,
          }),
        ],
        settings
      );

      return applied(settings);
    }

    case "NotifyOperator": {
      yield* apply(
        job,
        [
          write("POST", `/issues/${intent.pr}/comments`, {
            body: `${intent.outcome}\n${intent.detail}`,
          }),
        ],
        settings
      );

      return applied(settings);
    }

    default: {
      return yield* Effect.die(intent satisfies never);
    }
  }
});

export const execute = Effect.fn("Executor.execute")(function* execute(
  job: Job,
  settings: Settings
) {
  if (Predicate.isTagged(job, "release")) {
    return yield* executeRelease(job, settings);
  }

  const at = yield* Clock.currentTimeMillis;

  return yield* (
    Predicate.isTagged(job, "train")
      ? executeTrain(job, settings)
      : executeSolo(job, settings)
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed<Outcome>({
        error,
        events:
          job.intent.kind === "BuildTrain"
            ? [
                events.buildFailed({
                  at,
                  buildId: job.intent.buildId,
                  reason: error.message,
                }),
              ]
            : [],
        status: "failed",
      })
    )
  );
});
