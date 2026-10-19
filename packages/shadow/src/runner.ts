import type { Job, WouldDo } from "@joelhooks/piper-executor/domain";
import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { execute, Judge } from "@joelhooks/piper-executor/execute";
import { GitHub } from "@joelhooks/piper-executor/github";
import { Recorder } from "@joelhooks/piper-executor/recorder";
import { GitHubWrites } from "@joelhooks/piper-executor/writes";
import { PostedEventSchema, toTrainEvent } from "@joelhooks/piper/domain";
import {
  openTrain,
  readTrain,
  stepTrain,
  viewTrain,
} from "@joelhooks/piper/host";
import { Clock, Data, Effect, Layer, Result, Schema } from "effect";

import { compare } from "./compare.js";
import type { ActionValues, Frame, Recording } from "./domain.js";
import { ShadowError } from "./domain.js";
import { projectWouldDo } from "./project.js";

const jobs = Data.taggedEnum<Job>();

const dry = {
  baseBranch: "main",
  baselineWorkflows: {},
  mode: "dry-run",
} as const;

export const replayGitHub = (frame: Frame): GitHub["Service"] => ({
  read: (repo, path) => {
    const read = frame.reads.find(
      (item) => item.repo === repo && item.path === path
    );

    if (read === undefined || read.missing) {
      return Effect.fail(
        new ExecutorError({
          code: read === undefined ? "decode" : "not-found",
          message: `Recording has no response for ${path}`,
        })
      );
    }

    return Effect.succeed(read.value);
  },
});

export const runRecording = Effect.fn("Shadow.runRecording")(
  function* runRecording(recording: Recording, online?: GitHub["Service"]) {
    let persisted = yield* openTrain(recording.input);
    const seen = new Set<string>();
    const journal: WouldDo[] = [];
    const expected: ActionValues[] = [];
    const clock = yield* Clock.Clock;

    for (const [frameIndex, frame] of recording.frames.entries()) {
      const services = Layer.mergeAll(
        Layer.succeed(
          GitHub,
          frameIndex === recording.frames.length - 1 && online !== undefined
            ? online
            : replayGitHub(frame)
        ),
        Layer.succeed(Recorder, {
          append: (entry) =>
            Effect.sync(() => {
              journal.push(entry);
            }),
        }),
        Judge.absent,
        Layer.succeed(GitHubWrites, {
          write: () => Effect.die("Shadow attempted a write"),
        })
      );

      for (const event of frame.events) {
        const before = yield* readTrain(persisted);

        if (before.status !== "active") {
          break;
        }

        persisted = yield* stepTrain(persisted, [toTrainEvent(event)]);

        while (true) {
          const view = viewTrain(yield* readTrain(persisted));
          const intent = view.intents.find((item) => !seen.has(item.id));

          if (intent === undefined) {
            break;
          }

          seen.add(intent.id);
          const head = view.head ?? view.main ?? "unbuilt";
          const count = journal.length;

          const outcome = yield* execute(
            jobs.train({
              head,
              intent,
              repo: recording.input.repo,
              target: `/trains/${recording.input.train}`,
            }),
            dry
          ).pipe(
            Effect.provide(services),
            Effect.provideService(Clock.Clock, {
              currentTimeMillis: Effect.succeed(frame.at),
              currentTimeMillisUnsafe: () => frame.at,
              currentTimeNanos: clock.currentTimeNanos,
              currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
              monotonicTimeNanos: clock.monotonicTimeNanos,
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              sleep: (duration) => clock.sleep(duration),
            })
          );

          if (outcome.status === "failed") {
            return yield* Effect.fail(
              outcome.error ??
                new ShadowError({
                  message: "Executor failed without an error receipt",
                })
            );
          }

          for (const record of journal.slice(count)) {
            const projection = projectWouldDo(record, intent);

            const action = yield* Result.isSuccess(projection)
              ? Effect.succeed(projection.success)
              : Effect.fail(projection.failure);

            expected.push(action);
          }

          if (outcome.events.length > 0) {
            const posted = yield* Schema.decodeUnknownEffect(
              Schema.Array(PostedEventSchema)
            )(outcome.events);

            persisted = yield* stepTrain(persisted, posted.map(toTrainEvent));
          }
        }
      }
    }

    return {
      comparison: compare(expected, recording.trace),
      expected,
      journal,
      train: recording.input.train,
      view: viewTrain(yield* readTrain(persisted)),
    };
  }
);
