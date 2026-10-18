import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";

import { Journal, WriterLockSchema } from "../src/journal.js";

describe("file journal ownership", () => {
  it.effect(
    "a crash-left lock refuses restart with holder and exact recovery path",
    () =>
      Effect.gen(function* crashLeftLock() {
        const fs = yield* FileSystem.FileSystem;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "piper-executor-",
        });

        const holder = WriterLockSchema.make({
          cursor: "train-1/7",
          pid: 12_345,
          startedAt: 1000,
        });

        yield* fs.writeFileString(
          `${directory}/writer.lock`,
          JSON.stringify(holder)
        );
        yield* fs.writeFileString(`${directory}/journal.jsonl`, "");

        const result = yield* Journal.use((journal) => journal.entries).pipe(
          Effect.provide(Journal.file(directory)),
          Effect.result
        );

        expect(result).toHaveProperty("failure.code", "storage");
        expect(result).toHaveProperty(
          "failure.message",
          `Writer lock held: pid=12345 startedAt=1000 cursor=train-1/7. Verify process 12345 has exited, then remove only ${directory}/writer.lock and restart with the same --state. Preserve journal.jsonl.`
        );
        expect(yield* fs.readFileString(`${directory}/writer.lock`)).toBe(
          JSON.stringify(holder)
        );
        expect(yield* fs.readFileString(`${directory}/journal.jsonl`)).toBe("");
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "the owner records pid, start time and cursor without a hostname",
    () =>
      Effect.gen(function* holderMetadata() {
        const fs = yield* FileSystem.FileSystem;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "piper-executor-",
        });

        const holder = yield* Journal.use(() =>
          fs
            .readFileString(`${directory}/writer.lock`)
            .pipe(
              Effect.flatMap(
                Schema.decodeEffect(Schema.fromJsonString(WriterLockSchema))
              )
            )
        ).pipe(Effect.provide(Journal.file(directory)));

        expect(holder.pid).toBeGreaterThan(0);
        expect(holder.startedAt).toBe(0);
        expect(holder.cursor).toBeNull();
        expect(yield* fs.exists(`${directory}/writer.lock`)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer))
  );
});
