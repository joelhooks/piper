import { Config, Effect, Option, Redacted } from "effect";
import type { Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";

import { ObserveError } from "./domain.js";

export type TokenName = "AXIOM_ORG_ID" | "AXIOM_TOKEN" | "VERCEL_TOKEN";

export const requireToken = Effect.fn("Observe.requireToken")(
  function* requireToken(name: TokenName) {
    const value = yield* Config.option(Config.Redacted(name)).pipe(
      Effect.mapError(() => new ObserveError({ reason: `unreadable ${name}` }))
    );

    const present = value.pipe(
      Option.filter((token) => Redacted.value(token).trim() !== "")
    );

    if (Option.isNone(present)) {
      return yield* new ObserveError({ reason: `missing ${name}` });
    }

    return present.value;
  }
);

export const fetchJson = Effect.fn("Observe.fetchJson")(function* fetchJson<A>(
  provider: string,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Decoder<A>
) {
  const client = yield* HttpClient.HttpClient;

  const response = yield* client
    .execute(request)
    .pipe(
      Effect.mapError(
        () => new ObserveError({ reason: `${provider} request failed` })
      )
    );

  if (response.status < 200 || response.status >= 300) {
    return yield* new ObserveError({
      reason: `${provider} returned HTTP ${response.status}`,
    });
  }

  return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError(
      () =>
        new ObserveError({
          reason: `${provider} response did not match the expected shape`,
        })
    )
  );
});
