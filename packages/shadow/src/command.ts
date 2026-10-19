import { GitHub } from "@joelhooks/piper-executor/github";
import { TokenProvider } from "@joelhooks/piper-executor/token";
import { PostedEventSchema } from "@joelhooks/piper/domain";
import {
  Clock,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { capturePoll, captureReads, discoverTrains } from "./capture.js";
import { compare } from "./compare.js";
import { ShadowError, TraceSchema } from "./domain.js";
import type { RawRead, Recording } from "./domain.js";
import { GitHubFeed } from "./feed.js";
import { ReadReceipts, shadowGitHub } from "./http.js";
import { runRecording } from "./runner.js";
import {
  loadRecordings,
  privateDirectory,
  savePartial,
  saveRecording,
} from "./storage.js";
import { commandTokens } from "./token.js";
import { OperatorTrace, mergeTraces } from "./trace.js";

const EventsSchema = Schema.Array(
  Schema.Struct({ event: PostedEventSchema, train: Schema.Int })
);

export const command = Command.make(
  "piper-shadow",
  {
    autoGoBy: Flag.String("auto-go-by").pipe(Flag.withDefault("")),
    events: Flag.String("events").pipe(Flag.withDefault("")),
    minRateFraction: Flag.Finite("min-rate-fraction").pipe(
      Flag.withDefault(0.2)
    ),
    readInterval: Flag.Int("read-interval-ms").pipe(Flag.withDefault(2000)),
    record: Flag.String("record").pipe(Flag.withDefault("")),
    replay: Flag.String("replay").pipe(Flag.withDefault("")),
    repo: Flag.String("repo"),
    since: Flag.String("since"),
    tokenCommand: Flag.String("token-command").pipe(Flag.withDefault("")),
    tokenTtl: Flag.Int("token-ttl-ms").pipe(Flag.withDefault(3_000_000)),
    trace: Flag.String("trace").pipe(Flag.withDefault("")),
  },
  Effect.fn("Shadow.cli")(function* cli(options) {
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repo) ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/u.test(options.since) ||
      !Number.isFinite(Date.parse(options.since)) ||
      (options.record !== "" && options.replay !== "")
    ) {
      return yield* new ShadowError({
        message:
          "Expected owner/repo and UTC ISO --since; --record and --replay are exclusive",
      });
    }

    if (options.replay !== "") {
      const recordings = yield* loadRecordings(options.replay);

      for (const recording of recordings) {
        if (
          recording.input.repo !== options.repo ||
          recording.since !== options.since
        ) {
          return yield* new ShadowError({
            message: "Replay repo/since must match recording exactly",
          });
        }

        const report = yield* runRecording(recording);
        yield* Console.log(JSON.stringify(report));
      }

      return yield* Effect.void;
    }

    const directory =
      options.record === "" ? "" : yield* privateDirectory(options.record);

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const supplied =
      options.events === ""
        ? []
        : yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(EventsSchema)
          )(yield* fs.readFileString(options.events));

    const configuredToken = yield* Config.option(
      Config.Redacted("GITHUB_TOKEN")
    );

    const token = Option.getOrElse(configuredToken, () => Redacted.make(""));

    const expiresAt =
      options.tokenCommand === ""
        ? yield* Config.Int("PIPER_GITHUB_TOKEN_EXPIRES_AT").pipe(
            Config.withDefault(0)
          )
        : 0;

    if (options.tokenCommand !== "" && Option.isSome(configuredToken)) {
      return yield* new ShadowError({
        message: "--token-command and GITHUB_TOKEN are mutually exclusive",
      });
    }

    const networkReads: RawRead[] = [];

    const dependencies = Layer.mergeAll(
      options.tokenCommand === ""
        ? TokenProvider.fromValue(token, expiresAt)
        : commandTokens(options.tokenCommand, options.tokenTtl),
      FetchHttpClient.layer,
      Layer.succeed(ReadReceipts, {
        append: (read) =>
          Effect.sync(() => {
            networkReads.push(read);
          }),
      })
    );

    const github = shadowGitHub(
      options.readInterval,
      options.minRateFraction
    ).pipe(Layer.provide(dependencies));

    const recordings = new Map<number, Recording>();

    const poll = Effect.gen(function* poll() {
      const at = yield* Clock.currentTimeMillis;
      const provider = yield* GitHub;
      const discoveryReads: RawRead[] = [];

      const trains = yield* discoverTrains(options.repo, options.since).pipe(
        Effect.provideService(GitHub, captureReads(provider, discoveryReads))
      );

      for (const train of trains) {
        const recording =
          recordings.get(train.train) ??
          ({
            frames: [],
            input: {
              ciTimeoutMs: 1_800_000,
              ignoredChecks: [],
              maxCars: 5,
              pollMs: 60_000,
              repo: options.repo,
              train: train.train,
              trainLabel: "train",
            },
            since: options.since,
            trace: { acceptances: [], actions: [], complete: false },
            version: 1,
          } satisfies Recording);

        const lastAt =
          recording.frames.at(-1)?.at ?? Date.parse(options.since) - 1;

        const events = supplied.flatMap((item) =>
          item.train === train.train &&
          item.event.at > lastAt &&
          item.event.at <= at
            ? [item.event]
            : []
        );

        if (directory !== "") {
          yield* saveRecording(directory, recording);
        }

        const reads: RawRead[] = [];

        const readers = Layer.mergeAll(
          GitHubFeed.layer,
          OperatorTrace.github
        ).pipe(
          Layer.provideMerge(
            Layer.succeed(GitHub, captureReads(provider, reads))
          )
        );

        const captured = yield* capturePoll(
          recording,
          train.pull.number,
          at,
          events,
          reads,
          {
            autoGo:
              options.autoGoBy === "" ? undefined : { by: options.autoGoBy },
          }
        ).pipe(Effect.provide(readers));

        let { trace } = captured.recording;

        if (options.trace !== "") {
          const external = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(TraceSchema)
          )(
            yield* fs.readFileString(
              path.join(options.trace, `train-${train.train}.json`)
            )
          );

          trace = mergeTraces([trace, external]);
        }

        const latest = captured.recording.frames.at(-1);

        const next = {
          ...captured.recording,
          frames: captured.recording.frames.map((frame) =>
            frame === latest
              ? { ...frame, reads: [...discoveryReads, ...frame.reads] }
              : frame
          ),
          trace,
        };

        recordings.set(train.train, {
          ...next,
          trace: captured.recording.trace,
        });

        if (directory !== "") {
          yield* saveRecording(directory, next);
        }

        yield* Console.log(
          JSON.stringify({
            ...captured.report,
            comparison: compare(captured.report.expected, trace),
          })
        );
      }
    });

    return yield* poll.pipe(
      Effect.repeat(Schedule.spaced("60 seconds")),
      Effect.tapError(() =>
        directory === ""
          ? Effect.void
          : savePartial(directory, networkReads, "read-stopped")
      ),
      Effect.provide(github)
    );
  })
);
