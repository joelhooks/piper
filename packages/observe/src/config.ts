import { Effect, Schema } from "effect";

import { ObserveConfigSchema } from "./domain.js";

export class ConfigInvalid extends Schema.TaggedError<
  ConfigInvalid,
  { readonly brand: unique symbol }
>()("ConfigInvalid", { message: Schema.String }) {}

const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ObserveConfigSchema),
  { errors: "all", onExcessProperty: "error" }
);

export const decodeConfig = (text: string) =>
  decode(text).pipe(
    Effect.mapError(({ message }) => new ConfigInvalid({ message }))
  );
