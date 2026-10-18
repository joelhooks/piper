import { Clock, Context, Effect, Layer, Redacted, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { ExecutorError } from "./domain.js";
import type { Write } from "./domain.js";

export interface Request {
  readonly method: "GET" | Write["method"];
  readonly url: string;
  readonly token: Redacted.Redacted;
  readonly body?: Write["body"];
}

export class Transport extends Context.Service<
  Transport,
  {
    readonly request: (
      request: Request
    ) => Effect.Effect<unknown, ExecutorError>;
  }
>()("piper-executor/Transport") {
  static layer(intervalMs = 1000) {
    return Layer.effect(
      Transport,
      Effect.gen(function* makeTransport() {
        const client = yield* HttpClient.HttpClient;
        const semaphore = yield* Semaphore.make(1);
        let next = 0;

        const request = Effect.fn("Transport.request")(function* request(
          input: Request
        ) {
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.sleep(Math.max(0, next - now));
          const started = yield* Clock.currentTimeMillis;
          next = started + Math.max(1, intervalMs);

          const req = HttpClientRequest.make(input.method)(input.url).pipe(
            HttpClientRequest.setHeaders({
              accept: "application/vnd.github+json",
              authorization: `Bearer ${Redacted.value(input.token)}`,
              "user-agent": "piper-executor",
              "x-github-api-version": "2022-11-28",
            })
          );

          const response = yield* client
            .execute(
              input.body === undefined
                ? req
                : HttpClientRequest.bodyJsonUnsafe(req, input.body)
            )
            .pipe(
              Effect.mapError(
                () =>
                  new ExecutorError({
                    code: "transport",
                    message:
                      "HTTP request failed; credentials and provider body withheld",
                  })
              )
            );

          if (response.status === 403 || response.status === 429) {
            const seconds = Number(response.headers["retry-after"] ?? "60");

            const retryAfterMs = Math.max(
              60_000,
              Number.isFinite(seconds) ? seconds * 1000 : 60_000
            );

            next = (yield* Clock.currentTimeMillis) + retryAfterMs;

            return yield* new ExecutorError({
              code: "secondary-limit",
              message:
                "Provider refused request; subsequent requests are delayed",
              retryAfterMs,
            });
          }

          if (response.status === 404) {
            return yield* new ExecutorError({
              code: "not-found",
              message: "Provider resource not found",
            });
          }

          if (response.status === 409 || response.status === 422) {
            return yield* new ExecutorError({
              code: "head-mismatch",
              message: "Provider refused the requested head or merge",
            });
          }

          if (response.status < 200 || response.status >= 300) {
            return yield* new ExecutorError({
              code: "provider",
              message: `Provider returned HTTP ${response.status}`,
            });
          }

          if (response.status === 204) {
            return null;
          }

          return yield* response.json.pipe(
            Effect.mapError(
              () =>
                new ExecutorError({
                  code: "decode",
                  message: "Provider returned invalid JSON",
                })
            )
          );
        }, semaphore.withPermits(1));

        return Transport.of({ request });
      })
    );
  }
}
