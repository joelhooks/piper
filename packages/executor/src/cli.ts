import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { runAdmitted } from "./admission.js";
import { ExecutorError } from "./domain.js";
import { runOnce } from "./drain.js";
import { Judge } from "./execute.js";
import { GitHub } from "./github.js";
import { Journal, recorderLayer } from "./journal.js";
import {
  ReleaseCommandConfig,
  ReleaseCommandsSchema,
  releaseWriters,
} from "./release.js";
import { TokenProvider } from "./token.js";
import { trainCommand } from "./train-cli.js";
import { Transport } from "./transport.js";
import { Outbox } from "./worker.js";
import { writers } from "./writes.js";

const command = Command.make(
  "piper-executor",
  {
    api: Flag.String("api"),
    baseBranch: Flag.String("base-branch").pipe(Flag.withDefault("main")),
    mode: Flag.Literals("mode", ["dry-run", "live"]).pipe(
      Flag.withDefault("dry-run")
    ),
    readInterval: Flag.Int("read-interval-ms").pipe(Flag.withDefault(1000)),
    repo: Flag.String("repo"),
    state: Flag.String("state").pipe(Flag.withDefault(".piper-executor")),
  },
  Effect.fn("CLI.execute")(function* command(options) {
    return yield* runAdmitted(options.mode, options.repo, () =>
      Effect.gen(function* configured() {
        if (
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repo) ||
          !/^https?:\/\//u.test(options.api) ||
          options.readInterval < 1
        ) {
          return yield* new ExecutorError({
            code: "configuration",
            message:
              "Expected owner/repo, an HTTP API URL and a positive read interval",
          });
        }

        const token = yield* Config.Redacted("GITHUB_TOKEN").pipe(
          Config.withDefault(Redacted.make(""))
        );

        const expiresAt = yield* Config.Int(
          "PIPER_GITHUB_TOKEN_EXPIRES_AT"
        ).pipe(Config.withDefault(0));

        const apiToken = yield* Config.Redacted("PIPER_API_TOKEN").pipe(
          Config.withDefault(Redacted.make(""))
        );

        const workflowsJson = yield* Config.String(
          "PIPER_BASELINE_WORKFLOWS"
        ).pipe(Config.withDefault("{}"));

        const baselineWorkflows = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.String))
        )(workflowsJson);

        const releaseJson = yield* Config.String("PIPER_RELEASE_COMMANDS").pipe(
          Config.withDefault("{}")
        );

        const releaseCommands = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ReleaseCommandsSchema)
        )(releaseJson);

        const transport = Transport.layer(options.readInterval).pipe(
          Layer.provide(FetchHttpClient.layer)
        );

        const tokens = TokenProvider.fromValue(token, expiresAt);
        const dependencies = Layer.mergeAll(transport, tokens);
        const journal = Journal.file(options.state);

        const services = Layer.mergeAll(
          GitHub.layer,
          writers(options.mode),
          Outbox.worker(options.repo, options.api, apiToken)
        ).pipe(Layer.provide(dependencies));

        const runtime = Layer.mergeAll(
          services,
          releaseWriters(options.mode),
          Layer.succeed(ReleaseCommandConfig, releaseCommands),
          Judge.absent,
          recorderLayer.pipe(Layer.provide(journal)),
          journal
        );

        yield* TokenProvider.use((provider) => provider.token).pipe(
          Effect.provide(tokens)
        );

        return yield* runOnce({
          baseBranch: options.baseBranch,
          baselineWorkflows,
          mode: options.mode,
        }).pipe(
          Effect.repeat(Schedule.spaced("30 seconds")),
          Effect.asVoid,
          Effect.provide(runtime)
        );
      })
    );
  })
);

NodeRuntime.runMain(
  command.pipe(
    Command.withSubcommands([trainCommand]),
    Command.run({ version: "0.2.0" }),
    Effect.provide(NodeServices.layer)
  )
);
