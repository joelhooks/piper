import {
  Clock,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Predicate,
  Schema,
} from "effect";

import { decode } from "./boundary.js";
import {
  ExecutorError,
  JobSchema,
  OutcomeSchema,
  WouldDoSchema,
} from "./domain.js";
import type { Job, Outcome } from "./domain.js";
import { Recorder } from "./recorder.js";

const failure = () =>
  new ExecutorError({
    code: "storage",
    message:
      "Journal unavailable or locked; inspect journal before removing a stale lock",
  });

export const WriterLockSchema = Schema.Struct({
  cursor: Schema.NullOr(Schema.String),
  pid: Schema.Int,
  startedAt: Schema.Int,
});

const lockRefusal = Effect.fn("Journal.lockRefusal")(function* lockRefusal(
  path: string
) {
  const fs = yield* FileSystem.FileSystem;

  const holder = yield* fs.readFileString(`${path}/writer.lock`).pipe(
    Effect.flatMap(decode(Schema.fromJsonString(WriterLockSchema))),
    Effect.catch(() =>
      Effect.fail(
        new ExecutorError({
          code: "storage",
          message: `Writer lock holder is unreadable. Inspect ${path}/writer.lock and verify no writer is running before removing only that lock; preserve journal.jsonl.`,
        })
      )
    )
  );

  return yield* new ExecutorError({
    code: "storage",
    message: `Writer lock held: pid=${holder.pid} startedAt=${holder.startedAt} cursor=${holder.cursor ?? "none"}. Verify process ${holder.pid} has exited, then remove only ${path}/writer.lock and restart with the same --state. Preserve journal.jsonl.`,
  });
});

export const EntrySchema = Schema.Union([
  Schema.TaggedStruct("claimed", { job: JobSchema }),
  Schema.TaggedStruct("settled", { job: JobSchema, outcome: OutcomeSchema }),
  Schema.TaggedStruct("delivering", { job: JobSchema }),
  Schema.TaggedStruct("delivered", { job: JobSchema }),
  Schema.TaggedStruct("would-do", { record: WouldDoSchema }),
]);

export type Entry = typeof EntrySchema.Type;

export const records = Data.taggedEnum<Entry>();

export const identity = (job: Job) =>
  JSON.stringify([job.repo, job._tag, job.target, job.intent.id]);

export class Journal extends Context.Service<
  Journal,
  {
    readonly entries: Effect.Effect<readonly Entry[], ExecutorError>;
    readonly append: (entry: Entry) => Effect.Effect<void, ExecutorError>;
  }
>()("piper-executor/Journal") {
  static file(path: string) {
    return Layer.effect(
      Journal,
      Effect.gen(function* makeJournal() {
        const fs = yield* FileSystem.FileSystem;
        yield* fs
          .makeDirectory(path, { mode: 0o700, recursive: true })
          .pipe(Effect.mapError(failure));

        const lock = yield* fs
          .open(`${path}/writer.lock`, { flag: "wx", mode: 0o600 })
          .pipe(Effect.catch(() => lockRefusal(path)));

        yield* Effect.addFinalizer(() =>
          fs.remove(`${path}/writer.lock`).pipe(Effect.orDie)
        );

        const holder = {
          cursor: null,
          pid: yield* Effect.sync(() => process.pid),
          startedAt: yield* Clock.currentTimeMillis,
        } satisfies typeof WriterLockSchema.Type;

        yield* lock
          .writeAll(new TextEncoder().encode(JSON.stringify(holder)))
          .pipe(Effect.mapError(failure));
        yield* lock.sync.pipe(Effect.mapError(failure));

        const file = yield* fs
          .open(`${path}/journal.jsonl`, { flag: "a+", mode: 0o600 })
          .pipe(Effect.mapError(failure));

        const stat = yield* fs
          .stat(`${path}/journal.jsonl`)
          .pipe(Effect.mapError(failure));

        if (stat.size > 33_554_432) {
          return yield* new ExecutorError({
            code: "storage",
            message:
              "Journal exceeds 32 MiB; archive only after operator reconciliation, never discard cursor claims",
          });
        }

        const contents = yield* fs
          .readFileString(`${path}/journal.jsonl`)
          .pipe(Effect.mapError(failure));

        const entries: Entry[] = [];

        for (const line of contents.split("\n").filter((text) => text !== "")) {
          entries.push(yield* decode(Schema.fromJsonString(EntrySchema))(line));
        }

        const previous = entries.findLast((entry) =>
          Predicate.isTagged(entry, "settled")
        );

        const cursor = previous?.job.intent.id ?? null;
        yield* lock.seek(0n, "start").pipe(Effect.mapError(failure));
        yield* lock.truncate(0).pipe(Effect.mapError(failure));
        yield* lock
          .writeAll(
            new TextEncoder().encode(JSON.stringify({ ...holder, cursor }))
          )
          .pipe(Effect.mapError(failure));
        yield* lock.sync.pipe(Effect.mapError(failure));

        const append = Effect.fn("Journal.append")(function* append(
          entry: Entry
        ) {
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(EntrySchema)
          )(entry).pipe(Effect.mapError(failure));

          yield* file
            .writeAll(new TextEncoder().encode(`${encoded}\n`))
            .pipe(Effect.mapError(failure));
          yield* file.sync.pipe(Effect.mapError(failure));
          entries.push(entry);
        });

        return Journal.of({ append, entries: Effect.sync(() => [...entries]) });
      })
    );
  }
}

export const recorderLayer = Layer.effect(
  Recorder,
  Effect.gen(function* recorderLayer() {
    const journal = yield* Journal;

    return Recorder.of({
      append: (record) => journal.append(records["would-do"]({ record })),
    });
  })
);

export const settled = (entries: readonly Entry[], job: Job) =>
  entries.some(
    (entry) =>
      Predicate.isTagged(entry, "settled") &&
      identity(entry.job) === identity(job)
  );

export const claimed = (entries: readonly Entry[], job: Job) =>
  entries.some(
    (entry) =>
      Predicate.isTagged(entry, "claimed") &&
      identity(entry.job) === identity(job)
  );

export const recover = Effect.fn("Journal.recover")(function* recover() {
  const journal = yield* Journal;
  const entries = yield* journal.entries;

  for (const entry of entries) {
    if (
      Predicate.isTagged(entry, "claimed") &&
      !settled(yield* journal.entries, entry.job)
    ) {
      const outcome: Outcome = {
        error: new ExecutorError({
          code: "interrupted",
          message:
            "Execution was interrupted; reconcile provider state manually, never replay this intent",
        }),
        events: [],
        status: "failed",
      };

      yield* journal.append(records.settled({ job: entry.job, outcome }));
    }
  }
});
