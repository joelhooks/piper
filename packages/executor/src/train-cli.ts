import { Effect, FileSystem, Layer, Redacted, Schema, Stream } from "effect";
import { Argument, Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { ExecutorError } from "./domain.js";
import { Judge } from "./execute.js";
import { GitHub } from "./github.js";
import { RecordSink } from "./record-sink.js";
import { Recorder } from "./recorder.js";
import { TokenProvider } from "./token.js";
import { TrainStore } from "./train-store.js";
import { decodeTrainAdmission, runTrain } from "./train.js";
import { Transport } from "./transport.js";
import { writers } from "./writes.js";

const commandToken = (command: string) =>
  Layer.effect(
    TokenProvider,
    Effect.gen(function* makeCommandToken() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const token = Effect.gen(function* readToken() {
        const child = yield* spawner.spawn(
          ChildProcess.make("sh", ["-c", command], {
            stderr: "ignore",
            stdin: "ignore",
          })
        );

        const output = yield* Stream.mkString(Stream.decodeText(child.stdout));
        const code = yield* child.exitCode;

        if (code !== 0 || output.trim() === "") {
          return yield* new ExecutorError({
            code: "missing-token",
            message: "Token command failed or returned an empty token",
          });
        }

        return Redacted.make(output.trim());
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          () =>
            new ExecutorError({
              code: "missing-token",
              message: "Token command failed",
            })
        )
      );

      return TokenProvider.of({ token });
    })
  );

export const trainCommand = Command.make(
  "train",
  {
    admission: Argument.String("admission.json"),
    directory: Argument.String("state-dir"),
  },
  Effect.fn("CLI.train")(function* trainCommand(options) {
    const fs = yield* FileSystem.FileSystem;

    const input = yield* fs.readFileString(options.admission).pipe(
      Effect.flatMap(
        Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))
      ),
      Effect.orElseSucceed(() => null)
    );

    const decoded = yield* decodeTrainAdmission(input).pipe(
      Effect.match({
        onFailure: (stop) => stop,
        onSuccess: (admitted) => admitted,
      })
    );

    const admission = "_tag" in decoded ? undefined : decoded;

    const dependencies = Layer.mergeAll(
      commandToken(admission?.tokenCommand ?? ""),
      Transport.layer(1).pipe(Layer.provide(FetchHttpClient.layer))
    );

    const services = Layer.mergeAll(
      GitHub.layer,
      writers(admission?.mode ?? "dry-run")
    ).pipe(Layer.provide(dependencies));

    const runtime = Layer.mergeAll(
      services,
      Judge.absent,
      Layer.succeed(Recorder, { append: () => Effect.void }),
      TrainStore.file(options.directory),
      RecordSink.console
    );

    const result = yield* runTrain(decoded).pipe(Effect.provide(runtime));
    yield* Effect.sync(() => {
      process.exitCode = result.success ? 0 : 1;
    });
  })
);
