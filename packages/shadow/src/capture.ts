import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { GitHub } from "@joelhooks/piper-executor/github";
import type { PostedEvent } from "@joelhooks/piper/domain";
import { Data, Effect, Predicate } from "effect";

import type { Frame, RawRead, Recording, Trace } from "./domain.js";
import type { Pull } from "./feed.js";
import { GitHubFeed, PullSchema, readPages } from "./feed.js";
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

export const discoverTrains = Effect.fn("Shadow.discoverTrains")(
  function* discoverTrains(repo: string, since: string) {
    const pulls = yield* readPages(
      repo,
      "/pulls?state=all&sort=created&direction=asc",
      PullSchema
    );

    return pulls.flatMap((pull) => {
      const number = /^train\/(?<train>[1-9][0-9]*)$/u.exec(pull.head.ref)
        ?.groups?.train;

      return number === undefined || pull.created_at < since
        ? []
        : [{ pull, train: Number(number) }];
    });
  }
);

const buildEvents = (
  previous: Report,
  trace: Trace,
  pulls: readonly Pull[],
  pr: number,
  at: number
): PostedEvent[] => {
  const { build } = previous.view;

  const observed = trace.actions.find(
    (action) => action.kind === "BuildTrain" && action.head === build?.base
  );

  const trainPull = pulls.find((pull) => pull.number === pr);

  if (
    build === undefined ||
    observed?.cars === undefined ||
    trainPull === undefined ||
    previous.view.head === trainPull.head.sha
  ) {
    return [];
  }

  const merged = observed.cars.flatMap((head) =>
    pulls.flatMap((pull) => (pull.head.sha === head ? [pull.number] : []))
  );

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
  at: number
): PostedEvent[] => {
  const events: PostedEvent[] = [];

  if (main !== undefined && main !== previous.view.main) {
    events.push(posted.mainMoved({ at, main }));
  }

  if (previous.view.pr === undefined && previous.view.head !== undefined) {
    events.push(posted.prOpened({ at, pr }));
  }

  const merged = trace.actions.find((action) => action.kind === "Merge");

  if (merged?.head !== undefined && merged.mergeSha !== undefined) {
    events.push(
      posted.merged({ at, head: merged.head, mergeSha: merged.mergeSha })
    );
  }

  events.push(posted.tick({ at }));

  return events;
};

const accumulateTrace = (previous: Trace, current: Trace): Trace => {
  const unique = new Map<string, Trace["actions"][number]>();

  for (const action of [
    ...previous.actions.filter((item) => item.kind === "BuildTrain"),
    ...current.actions,
  ]) {
    const { slot, ...observation } = action;
    unique.set(JSON.stringify(observation), { ...observation, slot });
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
    reads: RawRead[] = []
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

    if (previous === undefined) {
      events.push(posted.depart({ at }));
    } else {
      const pulls = yield* readPages(
        input.repo,
        "/pulls?state=all&sort=created&direction=asc",
        PullSchema
      ).pipe(Effect.provideService(GitHub, captured));

      events.push(
        ...buildEvents(previous, current, pulls, pr, at),
        ...observationEvents(previous, current, main, pr, at)
      );
    }

    events.push(
      ...supplied.filter((event) => !Predicate.isTagged(event, "plan"))
    );
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
