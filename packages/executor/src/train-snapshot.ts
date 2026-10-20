import { Effect, Schema } from "effect";

import type { TrainState } from "./train-domain.js";

const persistedFields = Schema.Record(Schema.String, Schema.Unknown);

const PersistedSnapshotSchema = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Undefined,
      status: Schema.Literal("active"),
    }),
    [persistedFields]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Unknown,
      status: Schema.Literal("done"),
    }),
    [persistedFields]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Unknown,
      output: Schema.Undefined,
      status: Schema.Literal("error"),
    }),
    [persistedFields]
  ),
  Schema.StructWithRest(
    Schema.Struct({
      error: Schema.Undefined,
      output: Schema.Undefined,
      status: Schema.Literal("stopped"),
    }),
    [persistedFields]
  ),
]);

export const restoreTrain = Effect.fn("Train.restore")(function* restoreTrain(
  state: TrainState
) {
  const fields = yield* Schema.decodeUnknownEffect(persistedFields)(
    state.train
  );

  return yield* Schema.decodeUnknownEffect(PersistedSnapshotSchema)({
    error: undefined,
    output: undefined,
    ...fields,
  });
});
