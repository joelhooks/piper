import {
  Clock,
  Console,
  Context,
  Effect,
  FileSystem,
  Layer,
  Predicate,
  Ref,
  Schema,
  Semaphore,
} from "effect";

import { ExecutorError } from "./domain.js";
import { MessageSink } from "./release-message-sink.js";
import { ReadyStore } from "./release-ready-store.js";
import type {
  ReleaseConfig,
  Ready,
  RunLogLine,
  VerdictRow,
} from "./release-run-domain.js";
import { ReadySchema, RunLogLineSchema } from "./release-run-domain.js";
import { RunLog, runLines } from "./release-run-log.js";
import { VerdictSink } from "./release-verdict-sink.js";
import { ReleaseCommands } from "./release.js";
import type { ReleaseCommandSchema } from "./release.js";

export { MessageSink } from "./release-message-sink.js";

export { ReadyStore } from "./release-ready-store.js";

export { RunLog } from "./release-run-log.js";

export { VerdictSink } from "./release-verdict-sink.js";

export const printOnlyReleaseLayer = Layer.mergeAll(
  Layer.succeed(MessageSink, { page: Console.log, send: Console.log }),
  Layer.succeed(VerdictSink, {
    write: (row) => Console.log(JSON.stringify(row)),
  })
);

export const releaseSinkLayer = <E, R>(
  action: "ready" | "fire",
  mode: "dry-run" | "live",
  live: () => Layer.Layer<MessageSink | VerdictSink, E, R>
) => (action === "fire" && mode === "live" ? live() : printOnlyReleaseLayer);

const storageFailure = () =>
  new ExecutorError({
    code: "storage",
    message:
      "Release storage is unavailable or locked; preserve the log and reconcile its writer before retrying",
  });

export const releaseMemoryStore = Effect.gen(function* releaseMemoryStore() {
  const lines = yield* Ref.make<readonly RunLogLine[]>([]);
  const ready = yield* Ref.make<Ready | null>(null);

  return Layer.mergeAll(
    Layer.succeed(RunLog, {
      append: (line) => Ref.update(lines, (previous) => [...previous, line]),
      lines: Ref.get(lines),
    }),
    Layer.succeed(ReadyStore, {
      read: Ref.get(ready),
      write: (value) => Ref.set(ready, value),
    })
  );
});

export const makeVerdictMemory = Effect.gen(function* makeVerdictMemory() {
  const rows = yield* Ref.make<readonly VerdictRow[]>([]);

  const layer = Layer.succeed(VerdictSink, {
    write: (row) =>
      Ref.update(rows, (previous) =>
        previous.some((old) => old.sha === row.sha && old.step === row.step)
          ? previous
          : [...previous, row]
      ),
  });

  return { layer, rows: Ref.get(rows) };
});

const tsvCell = (cell: string) => cell.replaceAll(/[\t\r\n]/gu, " ");

export const releaseFileStore = (path: string) =>
  Layer.effectContext(
    Effect.gen(function* makeFileStore() {
      const fs = yield* FileSystem.FileSystem;
      yield* fs
        .makeDirectory(path, { mode: 0o700, recursive: true })
        .pipe(Effect.mapError(storageFailure));

      const lock = yield* fs
        .open(`${path}/release.lock`, { flag: "wx", mode: 0o600 })
        .pipe(Effect.mapError(storageFailure));

      yield* Effect.addFinalizer(() =>
        fs.remove(`${path}/release.lock`).pipe(Effect.orDie)
      );
      yield* lock
        .writeAll(
          new TextEncoder().encode(String(yield* Clock.currentTimeMillis))
        )
        .pipe(Effect.mapError(storageFailure));

      const file = yield* fs
        .open(`${path}/run.jsonl`, { flag: "a+", mode: 0o600 })
        .pipe(Effect.mapError(storageFailure));

      const content = yield* fs
        .readFileString(`${path}/run.jsonl`)
        .pipe(Effect.mapError(storageFailure));

      const decoded = yield* Effect.forEach(
        content.split("\n").filter(Boolean),
        (line) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(RunLogLineSchema))(
            line
          )
      ).pipe(Effect.mapError(storageFailure));

      const lines = yield* Ref.make<readonly RunLogLine[]>(decoded);
      const mutex = yield* Semaphore.make(1);

      const append = Effect.fn("ReleaseFileStore.append")(
        function* append(line: RunLogLine) {
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(RunLogLineSchema)
          )(line).pipe(Effect.mapError(storageFailure));

          yield* file
            .writeAll(new TextEncoder().encode(`${encoded}\n`))
            .pipe(Effect.mapError(storageFailure));
          yield* file.sync.pipe(Effect.mapError(storageFailure));
          yield* Ref.update(lines, (previous) => [...previous, line]);
        },
        (effect) => mutex.withPermit(effect)
      );

      const read = Effect.gen(function* read() {
        if (
          !(yield* fs
            .exists(`${path}/READY`)
            .pipe(Effect.mapError(storageFailure)))
        ) {
          return null;
        }

        const text = yield* fs
          .readFileString(`${path}/READY`)
          .pipe(Effect.mapError(storageFailure));

        return yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(ReadySchema)
        )(text).pipe(Effect.mapError(storageFailure));
      });

      const write = Effect.fn("ReleaseFileStore.ready")(function* write(
        ready: Ready
      ) {
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(ReadySchema)
        )(ready).pipe(Effect.mapError(storageFailure));

        const pending = yield* fs
          .open(`${path}/READY.pending`, { flag: "w", mode: 0o600 })
          .pipe(Effect.mapError(storageFailure));

        yield* pending
          .writeAll(new TextEncoder().encode(encoded))
          .pipe(Effect.mapError(storageFailure));
        yield* pending.sync.pipe(Effect.mapError(storageFailure));
        yield* fs
          .rename(`${path}/READY.pending`, `${path}/READY`)
          .pipe(Effect.mapError(storageFailure));
      }, Effect.scoped);

      return Context.make(RunLog, { append, lines: Ref.get(lines) }).pipe(
        Context.add(ReadyStore, { read, write })
      );
    })
  );

export const liveFireSinks = (config: ReleaseConfig, verdictPath: string) =>
  Layer.effectContext(
    Effect.gen(function* makeLiveFireSinks() {
      const fs = yield* FileSystem.FileSystem;
      const runner = yield* ReleaseCommands;
      const log = yield* RunLog;
      const pageCommand = config.commands.PageOwner;
      const sendCommand = config.commands.MessageOwner;

      if (pageCommand === undefined || sendCommand === undefined) {
        return yield* new ExecutorError({
          code: "configuration",
          message: "Live fire requires MessageOwner and PageOwner commands",
        });
      }

      const file = yield* fs
        .open(verdictPath, { flag: "a+", mode: 0o600 })
        .pipe(Effect.mapError(storageFailure));

      const previous = yield* fs
        .readFileString(verdictPath)
        .pipe(Effect.mapError(storageFailure));

      const keys = yield* Ref.make(
        previous
          .split("\n")
          .map((line) => line.split("\t"))
          .filter((cells) => cells.length === 5)
          .map((cells) => JSON.stringify([cells[1], cells[2]]))
      );

      const mutex = yield* Semaphore.make(1);

      const write = Effect.fn("VerdictSink.file.write")(
        function* write(row: VerdictRow) {
          const key = JSON.stringify([tsvCell(row.sha), tsvCell(row.step)]);

          if ((yield* Ref.get(keys)).includes(key)) {
            return;
          }

          const line = [
            String(row.ts),
            row.sha,
            row.step,
            row.outcome,
            `${config.rowPrefix}${row.evidence}`,
          ]
            .map(tsvCell)
            .join("\t");

          yield* file
            .writeAll(new TextEncoder().encode(`${line}\n`))
            .pipe(Effect.mapError(storageFailure));
          yield* file.sync.pipe(Effect.mapError(storageFailure));
          yield* Ref.update(keys, (previousKeys) => [...previousKeys, key]);
        },
        (effect) => mutex.withPermit(effect)
      );

      const message = Effect.fn("MessageSink.command")(function* message(
        command: typeof ReleaseCommandSchema.Type,
        said: string,
        wake: boolean
      ) {
        const outcome = yield* runner
          .run({ args: [...command.args, said], command: command.command })
          .pipe(Effect.result);

        const at = yield* Clock.currentTimeMillis;

        if (Predicate.isTagged(outcome, "Failure")) {
          yield* log.append(
            runLines["message-failed"]({
              at,
              error: outcome.failure,
              said,
              wake,
            })
          );

          return yield* Effect.fail(outcome.failure);
        }

        return yield* log.append(runLines.said({ at, said, wake }));
      });

      return Context.make(VerdictSink, { write }).pipe(
        Context.add(MessageSink, {
          page: (text) => message(pageCommand, text, true),
          send: (text) => message(sendCommand, text, false),
        })
      );
    })
  );
