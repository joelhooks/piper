import { Effect, FileSystem, Path, Schema } from "effect";

import { RecordingSchema, ShadowError } from "./domain.js";
import type { RawRead, Recording } from "./domain.js";

export const privateDirectory = Effect.fn("Shadow.privateDirectory")(
  function* privateDirectory(directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.realPath(path.dirname(path.resolve(directory)));
    let cursor = parent;

    while (true) {
      if (yield* fs.exists(path.join(cursor, ".git"))) {
        return yield* new ShadowError({
          message: "Recordings must be outside every Git checkout",
        });
      }

      const next = path.dirname(cursor);

      if (next === cursor) {
        break;
      }

      cursor = next;
    }

    const target = path.join(parent, path.basename(directory));
    yield* fs.makeDirectory(target, { mode: 0o700 });
    yield* fs.chmod(target, 0o700);

    return target;
  }
);

export const saveRecording = Effect.fn("Shadow.saveRecording")(
  function* saveRecording(directory: string, recording: Recording) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const checked =
      yield* Schema.decodeUnknownEffect(RecordingSchema)(recording);

    const target = path.join(directory, `train-${checked.input.train}.json`);
    yield* fs.writeFileString(target, JSON.stringify(checked, null, 2), {
      mode: 0o600,
    });
  }
);

export const savePartial = Effect.fn("Shadow.savePartial")(
  function* savePartial(
    directory: string,
    reads: readonly RawRead[],
    code: string
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(
      path.join(directory, "partial.json"),
      JSON.stringify({ code, reads, version: 1 }, null, 2),
      { mode: 0o600 }
    );
  }
);

export const loadRecordings = Effect.fn("Shadow.loadRecordings")(
  function* loadRecordings(directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const names = yield* fs.readDirectory(directory);
    const recordings: Recording[] = [];

    for (const name of names.toSorted()) {
      if (/^train-[1-9][0-9]*\.json$/u.test(name)) {
        recordings.push(
          yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(RecordingSchema)
          )(yield* fs.readFileString(path.join(directory, name)))
        );
      }
    }

    if (recordings.length === 0) {
      return yield* new ShadowError({ message: "No train recordings found" });
    }

    return recordings;
  }
);
