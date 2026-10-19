import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { GitHub } from "@joelhooks/piper-executor/github";
import { Context, Effect, Layer, Schema } from "effect";

import type { OperatorAction, Trace } from "./domain.js";
import type { Pull } from "./feed.js";
import { PullSchema, readPages } from "./feed.js";

export interface TraceQuery {
  readonly repo: string;
  readonly train: number;
  readonly pr: number;
  readonly base: string;
  readonly since: string;
}

export const mergeTraces = (traces: readonly Trace[]): Trace => ({
  acceptances: traces.flatMap((trace) => trace.acceptances),
  actions: traces.flatMap((trace) => trace.actions),
  complete: traces.some((trace) => trace.complete),
});

export const combineSources = (
  sources: readonly OperatorTrace["Service"][]
): OperatorTrace["Service"] => ({
  read: (query) =>
    Effect.all(sources.map((source) => source.read(query))).pipe(
      Effect.map((traces) => mergeTraces(traces))
    ),
});

const CommitSchema = Schema.Struct({
  commit: Schema.Struct({ committer: Schema.Struct({ date: Schema.String }) }),
  parents: Schema.Array(Schema.Struct({ sha: Schema.String })),
  sha: Schema.String,
});

const TimelineSchema = Schema.Struct({
  commit_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.optionalKey(Schema.String),
  event: Schema.String,
  label: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
});

const buildAction = (
  pull: Pull,
  base: string,
  commits: readonly (typeof CommitSchema.Type)[]
): OperatorAction[] => {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const reversed: string[] = [];
  let cursor = pull.head.sha;
  let builtAt = 0;

  let remaining = commits.length;

  while (remaining > 0) {
    remaining -= 1;
    const commit = bySha.get(cursor);
    const [first, second] = commit?.parents ?? [];

    if (commit === undefined || first === undefined || second === undefined) {
      break;
    }

    reversed.push(second.sha);
    builtAt = Math.max(builtAt, Date.parse(commit.commit.committer.date));
    cursor = first.sha;

    if (cursor === base) {
      return [
        {
          at: builtAt,
          cars: reversed.toReversed(),
          head: base,
          kind: "BuildTrain",
          slot: 0,
          source: "github:commit-parents",
        },
      ];
    }
  }

  return [];
};

const carOwners = Effect.fn("Shadow.carOwners")(function* carOwners(
  query: TraceQuery,
  cars: readonly string[]
) {
  const github = yield* GitHub;
  const owners: number[] = [];

  for (const car of cars) {
    const pulls = yield* Schema.decodeUnknownEffect(Schema.Array(PullSchema))(
      yield* github.read(query.repo, `/commits/${car}/pulls`)
    );

    owners.push(
      ...pulls.flatMap((owner) =>
        owner.head.sha === car ? [owner.number] : []
      )
    );
  }

  return owners;
});

const labelActions = Effect.fn("Shadow.labelActions")(function* labelActions(
  query: TraceQuery,
  pull: Pull,
  cars: readonly string[]
) {
  const members = new Set([
    ...[...(pull.body ?? "").matchAll(/(?:Cars:|,)\s*(?<pr>\d+)/gu)].map(
      (match) => Number(match.groups?.pr)
    ),
    ...(yield* carOwners(query, cars)),
  ]);

  members.delete(query.pr);

  const since = query.since > pull.created_at ? query.since : pull.created_at;

  const changes = new Map<
    string,
    { at: number; label: string; prs: number[] }
  >();

  for (const member of [...members, query.pr]) {
    const timeline = yield* readPages(
      query.repo,
      `/issues/${member}/timeline?`,
      TimelineSchema
    );

    for (const change of timeline) {
      if (
        change.event === "unlabeled" &&
        change.created_at !== undefined &&
        change.created_at >= since &&
        change.label !== undefined
      ) {
        const label = change.label.name;
        const existing = changes.get(label);
        const at = Date.parse(change.created_at);

        if (existing === undefined) {
          changes.set(label, { at, label, prs: [member] });
        } else {
          existing.at = Math.max(existing.at, at);

          if (!existing.prs.includes(member)) {
            existing.prs.push(member);
          }
        }
      }
    }
  }

  return [...changes.values()].map((change): OperatorAction => ({
    ...change,
    kind: "RemoveLabels",
    slot: 0,
    source: "github:timeline",
  }));
});

const rerunActions = Effect.fn("Shadow.rerunActions")(function* rerunActions(
  query: TraceQuery,
  head: string
) {
  const github = yield* GitHub;

  const runs = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      total_count: Schema.Int,
      workflow_runs: Schema.Array(
        Schema.Struct({
          head_sha: Schema.String,
          run_attempt: Schema.Int,
          updated_at: Schema.String,
        })
      ),
    })
  )(
    yield* github.read(
      query.repo,
      `/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=100`
    )
  );

  if (runs.total_count > 100) {
    return yield* new ExecutorError({
      code: "provider",
      message: "Rerun read exceeds bound",
    });
  }

  return runs.workflow_runs.flatMap((run): OperatorAction[] =>
    run.run_attempt > 1 && run.updated_at >= query.since
      ? [
          {
            at: Date.parse(run.updated_at),
            head: run.head_sha,
            kind: "RerunChecks",
            slot: 0,
            source: "github:workflow-attempt",
          },
        ]
      : []
  );
});

const mergeAction = Effect.fn("Shadow.mergeAction")(function* mergeAction(
  query: TraceQuery,
  pull: Pull
) {
  if (
    pull.merged_at === null ||
    pull.merged_at < query.since ||
    pull.merge_commit_sha === null
  ) {
    return [];
  }

  const github = yield* GitHub;

  const merged = yield* Schema.decodeUnknownEffect(CommitSchema)(
    yield* github.read(query.repo, `/commits/${pull.merge_commit_sha}`)
  );

  const [, tested] = merged.parents;

  return tested === undefined
    ? []
    : [
        {
          at: Date.parse(pull.merged_at),
          head: tested.sha,
          kind: "Merge",
          mergeSha: pull.merge_commit_sha,
          prs: [query.pr],
          slot: 0,
          source: "github:merge-parents",
        } satisfies OperatorAction,
      ];
});

export const readGitHubTrace = Effect.fn("Shadow.githubTrace")(
  function* readGitHubTrace(query: TraceQuery) {
    const github = yield* GitHub;

    const pull = yield* Schema.decodeUnknownEffect(PullSchema)(
      yield* github.read(query.repo, `/pulls/${query.pr}`)
    );

    const commits = yield* readPages(
      query.repo,
      `/pulls/${query.pr}/commits?`,
      CommitSchema
    );

    const timeline = yield* readPages(
      query.repo,
      `/issues/${query.pr}/timeline?`,
      TimelineSchema
    );

    const actions = buildAction(pull, query.base, commits);
    actions.push(
      {
        at: Date.parse(pull.created_at),
        kind: "OpenTrainPr",
        prs: [query.pr],
        slot: 0,
        source: "github:pull",
      },
      ...(yield* labelActions(
        query,
        pull,
        actions.flatMap((action) =>
          action.kind === "BuildTrain" ? (action.cars ?? []) : []
        )
      )),
      ...(yield* rerunActions(query, pull.head.sha))
    );

    for (const entry of timeline) {
      if (
        entry.event === "ready_for_review" &&
        entry.created_at !== undefined &&
        entry.created_at >= query.since
      ) {
        const ready = {
          at: Date.parse(entry.created_at),
          kind: "MarkReady",
          prs: [query.pr],
          slot: 0,
          source: "github:timeline",
        } as const;

        actions.push(
          entry.commit_id === undefined || entry.commit_id === null
            ? ready
            : { ...ready, head: entry.commit_id }
        );
      }
    }

    actions.push(...(yield* mergeAction(query, pull)));

    return {
      acceptances: [],
      actions: actions
        .toSorted((left, right) => left.at - right.at)
        .map((action, slot) => ({ ...action, slot })),
      complete: false,
    };
  }
);

export class OperatorTrace extends Context.Service<
  OperatorTrace,
  {
    readonly read: (
      query: TraceQuery
    ) => Effect.Effect<Trace, ExecutorError | Schema.SchemaError>;
  }
>()("piper-shadow/OperatorTrace") {
  static readonly github = Layer.effect(
    OperatorTrace,
    Effect.gen(function* githubTrace() {
      const github = yield* GitHub;

      return OperatorTrace.of({
        read: (query) =>
          readGitHubTrace(query).pipe(Effect.provideService(GitHub, github)),
      });
    })
  );
}
