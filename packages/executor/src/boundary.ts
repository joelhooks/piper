import { Effect, flow, Schema } from "effect";

import { ExecutorError } from "./domain.js";

export const decode = <A, I>(schema: Schema.Codec<A, I>) =>
  flow(
    Schema.decodeUnknownEffect(schema),
    Effect.mapError(
      () =>
        new ExecutorError({
          code: "decode",
          message: "Boundary payload does not match its schema",
        })
    )
  );
