import { ReleasePlanSchema } from "@joelhooks/piper/release-domain";
import type {
  PostedReleaseEvent,
  ReleaseIntent,
  ReleaseReviewRequest,
} from "@joelhooks/piper/release-domain";
import { Clock, Context, Data, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { runAdmitted } from "./admission.js";
import { decode } from "./boundary.js";
import { ExecutorError } from "./domain.js";
import type { Job, Mode, Outcome, Write } from "./domain.js";
import { Recorder } from "./recorder.js";
import type { Settings } from "./services.js";

export const ReleaseCommandSchema = Schema.Struct({
  args: Schema.Array(Schema.String),
  command: Schema.NonEmptyString,
});

export const ReleaseCommandsSchema = Schema.Record(
  Schema.String,
  ReleaseCommandSchema
);

type Command = typeof ReleaseCommandSchema.Type;

export const ReleaseCommandConfig = Context.Reference<
  typeof ReleaseCommandsSchema.Type
>("piper-executor/ReleaseCommandConfig", { defaultValue: () => ({}) });

export const ReleaseCommands = Context.Reference<{
  readonly run: (command: Command) => Effect.Effect<string, ExecutorError>;
}>("piper-executor/ReleaseCommands", {
  defaultValue: () => ({
    run: () =>
      Effect.fail(
        new ExecutorError({
          code: "configuration",
          message: "Release command runner is absent",
        })
      ),
  }),
});

export const releaseCommandsLayer = Layer.effect(
  ReleaseCommands,
  Effect.gen(function* releaseCommandsLayer() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return {
      run: Effect.fn("ReleaseCommands.run")(
        function* run(command: Command) {
          const process = yield* spawner.spawn(
            ChildProcess.make(command.command, command.args, {
              shell: false,
              stderr: "ignore",
              stdin: "ignore",
            })
          );

          const output = yield* Stream.mkString(
            Stream.decodeText(process.stdout)
          );

          const code = yield* process.exitCode;

          if (code !== 0) {
            return yield* new ExecutorError({
              code: "provider",
              message: "Release command exited unsuccessfully",
            });
          }

          return output;
        },
        Effect.scoped,
        Effect.mapError(
          () =>
            new ExecutorError({
              code: "provider",
              message: "Release command failed",
            })
        )
      ),
    };
  })
);

export const releaseWriters = (
  mode: Mode,
  live = () => releaseCommandsLayer
) =>
  mode === "dry-run"
    ? Layer.succeed(ReleaseCommands, {
        run: () => Effect.die("Dry-run attempted a release command"),
      })
    : live();

export const ReleaseReviewer = Context.Reference<{
  readonly submit: (
    request: ReleaseReviewRequest
  ) => Effect.Effect<boolean, ExecutorError>;
}>("piper-executor/ReleaseReviewer", {
  defaultValue: () => ({ submit: () => Effect.succeed(false) }),
});

const events = Data.taggedEnum<PostedReleaseEvent>();

const BaselinedSchema = Schema.Struct({
  outcome: Schema.Literals(["pass", "fail", "unknown"]),
});

const ObservedSchema = Schema.StructWithRest(
  Schema.Struct({
    outcome: Schema.Literals(["pass", "fail", "unknown", "breach"]),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

export const commandLastLine = (output: string) =>
  output.trim().split("\n").at(-1) ?? "";

export type ReleaseOutcome = Omit<Outcome, "events"> & {
  readonly events: readonly PostedReleaseEvent[];
};

const completed = (
  posted: readonly PostedReleaseEvent[] = []
): ReleaseOutcome => ({
  events: posted,
  status: "done",
});

const record = Effect.fn("Release.record")(function* record(
  job: Extract<Job, { readonly _tag: "release" }>,
  operations: readonly Write[]
) {
  const recorder = yield* Recorder;
  yield* recorder.append({
    head: job.head,
    intentId: job.intent.id,
    kind: job.intent.kind,
    repo: job.repo,
    wouldDo: operations,
  });

  return { events: [], status: "recorded-would-do" } satisfies Outcome;
});

const resolve = Effect.fn("Release.resolve")(function* resolve(
  key: string,
  args: readonly string[]
) {
  const config = yield* ReleaseCommandConfig;
  const configured = config[key];

  if (configured === undefined) {
    return yield* new ExecutorError({
      code: "configuration",
      message: `Missing release command: ${key}`,
    });
  }

  return { args: [...configured.args, ...args], command: configured.command };
});

const runBaseline = Effect.fn("Executor.release.baseline")(
  function* runBaseline(
    job: Extract<Job, { readonly _tag: "release" }>,
    intent: Extract<ReleaseIntent, { readonly kind: "Baseline" }>,
    mode: Mode
  ) {
    const baselines: PostedReleaseEvent[] = [];
    const operations: Write[] = [];

    for (const { name: check } of intent.checks) {
      const args = ["--check", check, "--baseline"];

      if (mode === "dry-run") {
        const command = yield* resolve(`Observe:${check}`, args);

        operations.push({
          body: { args: command.args },
          method: "POST",
          path: command.command,
        });
      } else {
        const { outcome } = yield* Effect.gen(function* baseline() {
          const command = yield* resolve(`Observe:${check}`, args);
          const runner = yield* ReleaseCommands;
          const output = yield* runner.run(command);

          return yield* decode(Schema.fromJsonString(BaselinedSchema))(output);
        }).pipe(
          Effect.orElseSucceed((): typeof BaselinedSchema.Type => ({
            outcome: "unknown",
          }))
        );

        const baselinedAt = yield* Clock.currentTimeMillis;

        baselines.push(events.baselined({ at: baselinedAt, check, outcome }));
      }
    }

    return mode === "dry-run"
      ? yield* record(job, operations)
      : completed(baselines);
  }
);

const runReleaseIntent = Effect.fn("Executor.release.run")(
  function* runReleaseIntent(
    job: Extract<Job, { readonly _tag: "release" }>,
    settings: Settings
  ) {
    const { intent } = job;
    const at = yield* Clock.currentTimeMillis;

    if (intent.kind === "RequestReview") {
      if (settings.mode === "dry-run") {
        return yield* record(job, [
          {
            body: { docs: intent.docs, plan: intent.plan, runId: intent.runId },
            method: "POST",
            path: "RequestReview",
          },
        ]);
      }

      const reviewer = yield* ReleaseReviewer;

      const submitted = yield* reviewer.submit({
        docs: intent.docs,
        plan: intent.plan,
        runId: intent.runId,
      });

      return completed(submitted ? [] : [events.reviewUnavailable({ at })]);
    }

    if (intent.kind === "NotifyOwner") {
      const args =
        "check" in intent
          ? ["--cause", intent.cause, "--check", intent.check]
          : ["--cause", intent.cause];

      const command = yield* resolve("NotifyOwner", args);

      if (settings.mode === "dry-run") {
        return yield* record(job, [
          {
            body: { args: command.args },
            method: "POST",
            path: command.command,
          },
        ]);
      }

      const notifier = yield* ReleaseCommands;
      yield* notifier.run(command);

      return completed();
    }

    if (intent.kind === "Baseline") {
      return yield* runBaseline(job, intent, settings.mode);
    }

    const keys =
      intent.kind === "Observe"
        ? intent.checks.map(({ name: check }) => ({
            args: ["--check", check],
            key: `Observe:${check}`,
          }))
        : [
            {
              args: [
                "--target",
                intent.kind === "Restore" ? intent.to : intent.target,
              ],
              key: intent.kind,
            },
          ];

    const commands: Command[] = [];

    for (const key of keys) {
      commands.push(yield* resolve(key.key, key.args));
    }

    if (settings.mode === "dry-run") {
      return yield* record(
        job,
        commands.map((command) => ({
          body: { args: command.args },
          method: "POST",
          path: command.command,
        }))
      );
    }

    const runner = yield* ReleaseCommands;

    if (intent.kind === "Observe") {
      const observations: PostedReleaseEvent[] = [];

      for (const { name: check } of intent.checks) {
        const { outcome, ...detail } = yield* Effect.gen(function* observe() {
          const command = yield* resolve(`Observe:${check}`, [
            "--check",
            check,
          ]);

          const now = yield* Clock.currentTimeMillis;

          if (now >= intent.deadlineAt) {
            return { outcome: "unknown" } satisfies typeof ObservedSchema.Type;
          }

          const output = yield* runner
            .run(command)
            .pipe(Effect.timeout(Math.max(0, intent.deadlineAt - now)));

          return yield* decode(Schema.fromJsonString(ObservedSchema))(
            commandLastLine(output)
          );
        }).pipe(
          Effect.catch(() =>
            Effect.succeed<typeof ObservedSchema.Type>({ outcome: "unknown" })
          )
        );

        const observedAt = yield* Clock.currentTimeMillis;

        observations.push(
          events.observed({ at: observedAt, check, detail, outcome })
        );
      }

      return completed(observations);
    }

    const outputs: string[] = [];

    for (const command of commands) {
      outputs.push(yield* runner.run(command));
    }

    const finishedAt = yield* Clock.currentTimeMillis;

    switch (intent.kind) {
      case "PlanRelease": {
        const rows = yield* decode(Schema.fromJsonString(ReleasePlanSchema))(
          outputs[0]
        );

        return completed([events.planned({ at: finishedAt, rows })]);
      }

      case "Deploy": {
        return completed([events.deployed({ at: finishedAt })]);
      }

      case "Restore": {
        return completed([events.restored({ at: finishedAt })]);
      }

      default: {
        return yield* Effect.die(intent satisfies never);
      }
    }
  }
);

const failureEvents = (
  intent: ReleaseIntent,
  error: ExecutorError,
  at: number
): readonly PostedReleaseEvent[] => {
  switch (intent.kind) {
    case "NotifyOwner": {
      return [];
    }

    case "RequestReview": {
      return [events.reviewUnavailable({ at })];
    }

    case "Baseline": {
      return intent.checks.map(({ name: check }) =>
        events.baselined({ at, check, outcome: "unknown" })
      );
    }

    case "Observe": {
      return intent.checks.map(({ name: check }) =>
        events.observed({ at, check, outcome: "unknown" })
      );
    }

    case "Deploy":
    case "PlanRelease":
    case "Restore": {
      return [
        events.failed({ at, operation: intent.kind, reason: error.message }),
      ];
    }

    default: {
      return intent satisfies never;
    }
  }
};

export const executeRelease = Effect.fn("Executor.release")(
  function* executeRelease(
    job: Extract<Job, { readonly _tag: "release" }>,
    settings: Settings
  ) {
    return yield* runAdmitted(settings.mode, job.repo, () =>
      runReleaseIntent(job, settings).pipe(
        Effect.catch((error) =>
          Effect.gen(function* failed() {
            const at = yield* Clock.currentTimeMillis;

            return {
              error,
              events:
                settings.mode === "dry-run"
                  ? []
                  : failureEvents(job.intent, error, at),
              status: "failed",
            } satisfies Outcome;
          })
        )
      )
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed<ReleaseOutcome>({ error, events: [], status: "failed" })
      )
    );
  }
);
