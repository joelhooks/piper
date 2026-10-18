import { Clock, Context, Effect, Layer, Redacted } from "effect";

import { ExecutorError } from "./domain.js";

export class TokenProvider extends Context.Service<
  TokenProvider,
  {
    readonly token: Effect.Effect<Redacted.Redacted, ExecutorError>;
  }
>()("piper-executor/TokenProvider") {
  static fromValue(value: Redacted.Redacted, expiresAt = 0) {
    return Layer.succeed(TokenProvider, {
      token: Effect.gen(function* leasedToken() {
        const now = yield* Clock.currentTimeMillis;

        if (
          Redacted.value(value).trim() === "" ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= now ||
          expiresAt - now > 3_600_000
        ) {
          return yield* new ExecutorError({
            code: "missing-token",
            message:
              "A nonempty GitHub token with a declared expiry within one hour is required",
          });
        }

        return value;
      }),
    });
  }
}
