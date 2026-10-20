import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { openTrain } from "@joelhooks/piper/host";
import { Effect, FileSystem } from "effect";

import { TrainStore } from "../src/train-store.js";
import { admission } from "./train-fixture.js";

describe("train file store", () => {
  it.effect(
    "persists a private state and append-only lines and releases its lock",
    () =>
      Effect.gen(function* privateState() {
        const fs = yield* FileSystem.FileSystem;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "piper-train-",
        });

        const train = yield* openTrain(admission.input);
        const state = { seen: ["train-1/1"], train, writes: 1 };
        yield* Effect.scoped(
          Effect.gen(function* firstWriter() {
            const store = yield* TrainStore;
            expect(yield* store.load).toBeNull();
            yield* store.save(state);
            yield* store.append("first");
            yield* store.append("second");
            const stat = yield* fs.stat(`${directory}/state.json`);
            expect(stat.mode % 0o1000).toBe(0o600);
            expect(yield* fs.readFileString(`${directory}/log.jsonl`)).toBe(
              "first\nsecond\n"
            );
          }).pipe(Effect.provide(TrainStore.file(directory)))
        );
        expect(yield* fs.exists(`${directory}/runner.lock`)).toBe(false);
        yield* Effect.gen(function* secondWriter() {
          const store = yield* TrainStore;
          expect(JSON.stringify(yield* store.load)).toBe(JSON.stringify(state));
        }).pipe(Effect.provide(TrainStore.file(directory)));
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("refuses a concurrent writer without removing its lock", () =>
    Effect.gen(function* exclusive() {
      const fs = yield* FileSystem.FileSystem;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "piper-train-lock-",
      });

      yield* Effect.gen(function* holder() {
        yield* TrainStore;

        const attempted = yield* TrainStore.pipe(
          Effect.provide(TrainStore.file(directory)),
          Effect.flip
        );

        expect(attempted.code).toBe("storage");
        expect(yield* fs.exists(`${directory}/runner.lock`)).toBe(true);
      }).pipe(Effect.provide(TrainStore.file(directory)));
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect("does not treat corrupt state as a new train", () =>
    Effect.gen(function* corrupt() {
      const fs = yield* FileSystem.FileSystem;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "piper-train-corrupt-",
      });

      yield* fs.writeFileString(`${directory}/state.json`, "not-json");

      const error = yield* TrainStore.use((store) => store.load).pipe(
        Effect.provide(TrainStore.file(directory)),
        Effect.flip
      );

      expect(error.code).toBe("storage");
    }).pipe(Effect.provide(NodeServices.layer))
  );
});
