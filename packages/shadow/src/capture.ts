import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { GitHub } from "@joelhooks/piper-executor/github";
import type { PostedEvent } from "@joelhooks/piper/domain";
import { Data, Effect, Predicate, Schema } from "effect";

import type { Frame, RawRead, Recording, Trace } from "./domain.js";
import type { Pull } from "./feed.js";
import { GitHubFeed, PullSchema } from "./feed.js";
import { runRecording } from "./runner.js";
import { OperatorTrace } from "./trace.js";

const posted = Data.taggedEnum<PostedEvent>();

type Report = Effect.Success<ReturnType<typeof runRecording>>;

export const captureReads = (
  github: GitHub["Service"],
  reads: RawRead[]
): GitHub["Service"] => ({
  read: Effect.fn("Shadow.captureRead")(function* read(
    repo: string,
    path: string
  ) {
    const cached = reads.find(
      (item) => item.repo === repo && item.path === path
    );

    if (cached !== undefined) {
      return yield* cached.missing
        ? Effect.fail(
            new ExecutorError({ code: "not-found", message: `Missing ${path}` })
          )
        : Effect.succeed(cached.value);
    }

    return yield* github.read(repo, path).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          reads.push({ missing: false, path, repo, value });
        })
      ),
      Effect.tapError((error) =>
        error.code === "not-found"
          ? Effect.sync(() => {
              reads.push({ missing: true, path, repo, value: null });
            })
          : Effect.void
      )
    );
  }),
});

export const readRecentPulls = Effect.fn("Shadow.readRecentPulls")(
  function* readRecentPulls(repo: string, since: string) {
    const github = yield* GitHub;
    const values: Pull[] = [];

    for (let page = 1; page <= 10; page += 1) {
      const batch = yield* Schema.decodeUnknownEffect(Schema.Array(PullSchema))(
        yield* github.read(
          repo,
          `/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`
        )
      );

      values.push(...batch);

      const oldest = batch.at(-1);

      if (
        batch.length < 100 ||
        oldest === undefined ||
        oldest.created_at < since
      ) {
        return values;
      }
    }

    return yield* new ExecutorError({
      code: "provider",
      message: "Recent pulls exceed ten pages; refusing incomplete history",
    });
  }
);

export const discoverTrains = Effect.fn("Shadow.discoverTrains")(
  function* discoverTrains(repo: string, since: string) {
    const pulls = yield* readRecentPulls(repo, since);

    return pulls
      .flatMap((pull) => {
        const number = /^train\/(?<train>[1-9][0-9]*)$/u.exec(pull.head.ref)
          ?.groups?.train;

        return number === undefined || pull.created_at < since
          ? []
          : [{ pull, train: Number(number) }];
      })
      .toSorted((left, right) => left.train - right.train);
  }
);

const buildEvents = (
  previous: Report,
  trace: Trace,
  trainPull: Pull,
  owners: ReadonlyMap<string, readonly number[]>,
  at: number
): PostedEvent[] => {
  const { build } = previous.view;

  const observed = trace.actions.find(
    (action) => action.kind === "BuildTrain" && action.head === build?.base
  );

  if (
    build === undefined ||
    observed?.cars === undefined ||
    previous.view.head === trainPull.head.sha
  ) {
    return [];
  }

  const merged = observed.cars.flatMap((head) => owners.get(head) ?? []);

  return merged.length === observed.cars.length
    ? [
        posted.built({
          at,
          buildId: build.id,
          conflicted: [],
          head: trainPull.head.sha,
          merged,
        }),
      ]
    : [];
};

const observationEvents = (
  previous: Report,
  trace: Trace,
  main: string | undefined,
  pr: number,
  at: number,
  supplied: readonly PostedEvent[],
  autoGo: { readonly by: string } | undefined
): PostedEvent[] => {
  const events: PostedEvent[] = [];

  if (previous.view.pr === undefined && previous.view.head !== undefined) {
    events.push(posted.prOpened({ at, pr }));
  }

  events.push(posted.tick({ at }), ...supplied);

  if (autoGo !== undefined && previous.view.head !== undefined) {
    events.push(posted.go({ at, by: autoGo.by, head: previous.view.head }));
  }

  if (main !== undefined && main !== previous.view.main) {
    events.push(posted.mainMoved({ at, main }));
  }

  const merged = trace.actions.find((action) => action.kind === "Merge");

  if (merged?.head !== undefined && merged.mergeSha !== undefined) {
    events.push(
      posted.merged({ at, head: merged.head, mergeSha: merged.mergeSha })
    );
  }

  return events;
};

const observationKey = (
  observation: Omit<Trace["actions"][number], "slot">
): string =>
  JSON.stringify(
    Object.entries(observation).toSorted(([left], [right]) =>
      left.localeCompare(right)
    )
  );

const accumulateTrace = (previous: Trace, current: Trace): Trace => {
  const unique = new Map<string, Trace["actions"][number]>();

  for (const action of [
    ...previous.actions.filter((item) => item.kind === "BuildTrain"),
    ...current.actions,
  ]) {
    const { slot, ...observation } = action;
    unique.set(observationKey(observation), { ...observation, slot });
  }

  return {
    ...current,
    actions: [...unique.values()]
      .toSorted((left, right) => left.at - right.at)
      .map((action, slot) => ({ ...action, slot })),
  };
};

export const capturePoll = Effect.fn("Shadow.capturePoll")(
  function* capturePoll(
    recording: Recording,
    pr: number,
    at: number,
    supplied: readonly PostedEvent[] = [],
    reads: RawRead[] = [],
    options: {
      readonly autoGo?: { readonly by: string } | undefined;
    } = {}
  ) {
    const captured = yield* GitHub;
    const feedPort = yield* GitHubFeed;
    const tracePort = yield* OperatorTrace;

    const previous =
      recording.frames.length === 0
        ? undefined
        : yield* runRecording(recording);

    const { input } = recording;
    const feed = yield* feedPort.poll(input, at);

    const main = feed
      .flatMap((event) =>
        Predicate.isTagged(event, "candidates") ? [event.main] : []
      )
      .at(0);

    const base = previous?.view.build?.base ?? main ?? "unknown";

    const current = yield* tracePort.read({
      base,
      pr,
      repo: input.repo,
      since: recording.since,
      train: input.train,
    });

    const trace = accumulateTrace(recording.trace, current);

    const events: PostedEvent[] = [
      ...supplied.filter(Predicate.isTagged("plan")),
      ...feed,
    ];

    const operatorEvents = supplied.filter(
      (event) => !Predicate.isTagged(event, "plan")
    );

    if (previous === undefined) {
      events.push(posted.depart({ at }), ...operatorEvents);
    } else {
      const lookup = Effect.gen(function* lookup() {
        const trainPull = yield* Schema.decodeUnknownEffect(PullSchema)(
          yield* captured.read(input.repo, `/pulls/${pr}`)
        );

        const cars = new Set(
          current.actions.flatMap((action) =>
            action.kind === "BuildTrain" ? (action.cars ?? []) : []
          )
        );

        const owners = new Map<string, readonly number[]>();

        for (const head of cars) {
          const associated = yield* Schema.decodeUnknownEffect(
            Schema.Array(PullSchema)
          )(yield* captured.read(input.repo, `/commits/${head}/pulls`));

          owners.set(
            head,
            associated.flatMap((pull) =>
              pull.head.sha === head ? [pull.number] : []
            )
          );
        }

        return { owners, trainPull };
      });

      const { owners, trainPull } = yield* lookup;

      events.push(
        ...buildEvents(previous, current, trainPull, owners, at),
        ...observationEvents(
          previous,
          current,
          main,
          pr,
          at,
          operatorEvents,
          options.autoGo
        )
      );
    }

    const frame: Frame = { at, events, reads };

    const next: Recording = {
      ...recording,
      frames: [...recording.frames, frame],
      trace,
    };

    const report = yield* runRecording(next, captured);

    return { recording: next, report };
  }
);
