import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Ref,
  Schema,
} from "effect";

import { decode } from "./boundary.js";
import { ExecutorError } from "./domain.js";
import { RecordSink } from "./record-sink.js";
import { TrainRecord, TrainStateSchema } from "./train-domain.js";
import type { TrainRecordPayload, TrainState } from "./train-domain.js";

const storageError = () =>
  new ExecutorError({
    code: "storage",
    message: "Train storage unavailable; preserve state and log for handback",
  });

export class TrainStore extends Context.Service<
  TrainStore,
  {
    readonly load: Effect.Effect<TrainState | null, ExecutorError>;
    readonly save: (state: TrainState) => Effect.Effect<void, ExecutorError>;
    readonly append: (line: string) => Effect.Effect<void, ExecutorError>;
  }
>()("piper-executor/TrainStore") {
  static file(directory: string) {
    return Layer.effect(
      TrainStore,
      Effect.gen(function* fileStore() {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .makeDirectory(directory, { mode: 0o700, recursive: true })
          .pipe(Effect.mapError(storageError));
        yield* fs
          .open(`${directory}/runner.lock`, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError(storageError));
        yield* Effect.addFinalizer(() =>
          fs.remove(`${directory}/runner.lock`).pipe(Effect.orDie)
        );

        const parent = yield* fs
          .open(directory, { flag: "r" })
          .pipe(Effect.mapError(storageError));

        const load = fs.readFileString(`${directory}/state.json`).pipe(
          Effect.flatMap(decode(Schema.fromJsonString(TrainStateSchema))),
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed(null)
          ),
          Effect.mapError(storageError)
        );

        const save = Effect.fn("TrainStore.save")(function* save(
          state: TrainState
        ) {
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(TrainStateSchema)
          )(state).pipe(Effect.mapError(storageError));

          const file = yield* fs
            .open(`${directory}/state.next`, { flag: "w", mode: 0o600 })
            .pipe(Effect.mapError(storageError));

          yield* file
            .writeAll(new TextEncoder().encode(encoded))
            .pipe(Effect.mapError(storageError));
          yield* fs
            .chmod(`${directory}/state.next`, 0o600)
            .pipe(Effect.mapError(storageError));
          yield* file.sync.pipe(Effect.mapError(storageError));
          yield* fs
            .rename(`${directory}/state.next`, `${directory}/state.json`)
            .pipe(Effect.mapError(storageError));
          yield* parent.sync.pipe(Effect.mapError(storageError));
        }, Effect.scoped);

        const append = Effect.fn("TrainStore.append")(function* append(
          line: string
        ) {
          const file = yield* fs
            .open(`${directory}/log.jsonl`, { flag: "a", mode: 0o600 })
            .pipe(Effect.mapError(storageError));

          yield* file
            .writeAll(new TextEncoder().encode(`${line}\n`))
            .pipe(Effect.mapError(storageError));
          yield* file.sync.pipe(Effect.mapError(storageError));
        }, Effect.scoped);

        return TrainStore.of({ append, load, save });
      })
    );
  }

  static memory(initial: TrainState | null = null) {
    return Effect.gen(function* memoryStore() {
      const state = yield* Ref.make(initial);
      const lines = yield* Ref.make<readonly string[]>([]);

      const layer = Layer.succeed(TrainStore, {
        append: (line) => Ref.update(lines, (current) => [...current, line]),
        load: Ref.get(state),
        save: (value) => Ref.set(state, value),
      });

      return { layer, lines: Ref.get(lines), state: Ref.get(state) };
    });
  }
}

export const recordTrain = Effect.fn("Train.record")(function* recordTrain(
  record: TrainRecordPayload
) {
  const store = yield* TrainStore;
  const sink = yield* RecordSink;
  const now = yield* DateTime.now;

  const stamped =
    "exit" in record ? record : { ...record, at: DateTime.formatIso(now) };

  const line = yield* Schema.encodeEffect(Schema.fromJsonString(TrainRecord))(
    stamped
  ).pipe(Effect.mapError(storageError));

  yield* store.append(line);
  yield* sink.write(line);
});
