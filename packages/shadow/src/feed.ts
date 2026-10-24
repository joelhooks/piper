import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { ApiRuns, workflowRun } from "@joelhooks/piper-executor/execute";
import { GitHub } from "@joelhooks/piper-executor/github";
import { CheckRunSchema } from "@joelhooks/piper/domain";
import type {
  PostedEvent,
  TrainInput,
  CandidateSchema,
} from "@joelhooks/piper/domain";
import { speakingChecks } from "@joelhooks/piper/policy";
import { Context, Data, Effect, Layer, Schema } from "effect";

import { ShadowError } from "./domain.js";

export const PullSchema = Schema.Struct({
  base: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  body: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  draft: Schema.Boolean,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  merge_commit_sha: Schema.NullOr(Schema.String),
  merged_at: Schema.NullOr(Schema.String),
  node_id: Schema.String,
  number: Schema.Int,
  state: Schema.String,
  user: Schema.Struct({ login: Schema.String }),
});

export type Pull = typeof PullSchema.Type;

const posted = Data.taggedEnum<PostedEvent>();

export const readPages = Effect.fn("Shadow.readPages")(function* readPages<
  A,
  I,
>(repo: string, path: string, schema: Schema.Codec<A, I>) {
  const github = yield* GitHub;
  const values: A[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const batch = yield* Schema.decodeUnknownEffect(Schema.Array(schema))(
      yield* github.read(repo, `${path}&per_page=100&page=${page}`)
    );

    values.push(...batch);

    if (batch.length < 100) {
      return values;
    }
  }

  return yield* new ExecutorError({
    code: "provider",
    message: "Read exceeds ten pages; refusing incomplete history",
  });
});

const ApiCheck = Schema.Struct({
  ...CheckRunSchema.fields,
  check_suite: Schema.optionalKey(Schema.Struct({ id: Schema.Int })),
  headSha: Schema.optionalKey(Schema.String),
  head_sha: Schema.String,
});

const readWorkflowRuns = Effect.fn("Shadow.readWorkflowRuns")(
  function* readWorkflowRuns(repo: string, head: string) {
    const github = yield* GitHub;

    const runs = yield* Schema.decodeUnknownEffect(ApiRuns)(
      yield* github.read(
        repo,
        `/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=100`
      )
    );

    return runs.workflow_runs.map(workflowRun);
  },
  Effect.orElseSucceed(() => [])
);

export const readChecks = Effect.fn("Shadow.readChecks")(function* readChecks(
  repo: string,
  head: string
) {
  const github = yield* GitHub;

  const response = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      check_runs: Schema.Array(ApiCheck),
      total_count: Schema.Int,
    })
  )(
    yield* github.read(
      repo,
      `/commits/${encodeURIComponent(head)}/check-runs?filter=latest&per_page=100&page=1`
    )
  );

  if (
    response.total_count !== response.check_runs.length ||
    response.check_runs.some((check) => check.head_sha !== head)
  ) {
    return yield* new ShadowError({
      message: "Incomplete checks or different head",
    });
  }

  const runs = yield* readWorkflowRuns(repo, head);

  return speakingChecks(
    response.check_runs.map((check) => ({
      ...check,
      suite: check.check_suite?.id,
    })),
    runs
  ).map((check) => ({
    conclusion: check.conclusion,
    headSha: head,
    name: check.name,
    status: check.status,
  }));
});

export const pollCandidates = Effect.fn("Shadow.pollCandidates")(
  function* pollCandidates(
    input: TrainInput,
    at: number,
    plans: readonly PostedEvent[] = []
  ) {
    const github = yield* GitHub;

    const main = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) })
    )(yield* github.read(input.repo, "/git/ref/heads/main"));

    const pulls = yield* readPages(
      input.repo,
      "/pulls?state=open&sort=created&direction=asc",
      PullSchema
    );

    const candidates: (typeof CandidateSchema.Type)[] = [];

    for (const pull of pulls) {
      if (
        !pull.head.ref.startsWith("train/") &&
        pull.labels.some((label) => label.name === input.trainLabel)
      ) {
        candidates.push({
          checks: yield* readChecks(input.repo, pull.head.sha),
          headSha: pull.head.sha,
          labels: pull.labels.map((label) => label.name),
          number: pull.number,
          operatorReviewed: pull.labels.some(
            (label) => label.name === "reviewed"
          ),
          owner: pull.user.login,
          upToDate:
            (yield* Schema.decodeUnknownEffect(
              Schema.Struct({
                merge_base_commit: Schema.Struct({ sha: Schema.String }),
              })
            )(
              yield* github.read(
                input.repo,
                `/compare/${encodeURIComponent(main.object.sha)}...${encodeURIComponent(pull.head.sha)}`
              )
            )).merge_base_commit.sha === main.object.sha,
        });
      }
    }

    return [
      ...plans,
      posted.candidates({ at, candidates, main: main.object.sha }),
    ];
  }
);

export class GitHubFeed extends Context.Service<
  GitHubFeed,
  {
    readonly poll: (
      input: TrainInput,
      at: number
    ) => Effect.Effect<
      readonly PostedEvent[],
      ExecutorError | Schema.SchemaError | ShadowError
    >;
  }
>()("piper-shadow/GitHubFeed") {
  static readonly layer = Layer.effect(
    GitHubFeed,
    Effect.gen(function* githubFeed() {
      const github = yield* GitHub;

      return GitHubFeed.of({
        poll: (input, at) =>
          pollCandidates(input, at).pipe(Effect.provideService(GitHub, github)),
      });
    })
  );
}
