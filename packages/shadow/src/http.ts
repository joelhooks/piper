import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { GitHub } from "@joelhooks/piper-executor/github";
import { TokenProvider } from "@joelhooks/piper-executor/token";
import { Clock, Context, Effect, Layer, Redacted, Semaphore } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { RawRead } from "./domain.js";
import { ReadAttempt, readWithBackoff } from "./read-machine.js";

export class ReadReceipts extends Context.Service<
  ReadReceipts,
  {
    readonly append: (read: RawRead) => Effect.Effect<void>;
  }
>()("piper-shadow/ReadReceipts") {}

export const retryDelay = (header: string | undefined, now: number): number => {
  if (header === undefined) {
    return 60_000;
  }

  const seconds = Number(header);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(header);

  return Number.isFinite(date) ? Math.max(0, date - now) : 60_000;
};

export const belowBudget = (
  remaining: string | undefined,
  limit: string | undefined,
  minimum: number
): boolean => {
  const available = Number(remaining);
  const total = Number(limit);

  return (
    remaining !== undefined &&
    limit !== undefined &&
    Number.isFinite(available) &&
    Number.isFinite(total) &&
    total > 0 &&
    available / total < minimum
  );
};

export const shadowGitHub = (intervalMs = 2000, minimum = 0.2) =>
  Layer.effect(
    GitHub,
    Effect.gen(function* makeReadLayer() {
      if (
        !Number.isFinite(intervalMs) ||
        intervalMs < 1 ||
        !Number.isFinite(minimum) ||
        minimum < 0 ||
        minimum > 1
      ) {
        return yield* new ExecutorError({
          code: "configuration",
          message: "Invalid shadow read interval or minimum rate fraction",
        });
      }

      const client = yield* HttpClient.HttpClient;
      const tokens = yield* TokenProvider;
      const receipts = yield* ReadReceipts;
      const semaphore = yield* Semaphore.make(1);
      let next = 0;

      const read = Effect.fn("Shadow.httpRead")(function* read(request: {
        readonly repo: string;
        readonly path: string;
      }) {
        if (
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(request.repo) ||
          !request.path.startsWith("/") ||
          request.path.startsWith("//") ||
          request.path.includes("\\")
        ) {
          return yield* new ExecutorError({
            code: "configuration",
            message: "Expected a repository-relative GitHub read",
          });
        }

        yield* Effect.sleep(
          Math.max(0, next - (yield* Clock.currentTimeMillis))
        );
        next = (yield* Clock.currentTimeMillis) + intervalMs;
        const token = yield* tokens.token;

        const response = yield* client
          .execute(
            HttpClientRequest.get(
              `https://api.github.com/repos/${request.repo}${request.path}`
            ).pipe(
              HttpClientRequest.setHeaders({
                accept: "application/vnd.github+json",
                authorization: `Bearer ${Redacted.value(token)}`,
                "user-agent": "piper-shadow",
                "x-github-api-version": "2022-11-28",
              })
            )
          )
          .pipe(
            Effect.mapError(
              () =>
                new ExecutorError({
                  code: "transport",
                  message: "Shadow GET failed; provider details withheld",
                })
            )
          );

        const limited = belowBudget(
          response.headers["x-ratelimit-remaining"],
          response.headers["x-ratelimit-limit"],
          minimum
        );

        if (response.status >= 200 && response.status < 300) {
          const value =
            response.status === 204
              ? null
              : yield* response.json.pipe(
                  Effect.mapError(
                    () =>
                      new ExecutorError({
                        code: "decode",
                        message: "GitHub returned invalid JSON",
                      })
                  )
                );

          yield* receipts.append({
            missing: false,
            path: request.path,
            repo: request.repo,
            value,
          });

          if (!limited) {
            return value;
          }
        }

        if (limited) {
          return yield* new ExecutorError({
            code: "secondary-limit",
            message:
              "Shadow stopped: shared GitHub rate budget is below the configured minimum",
          });
        }

        if (response.status === 403 || response.status === 429) {
          const now = yield* Clock.currentTimeMillis;

          const retryAfterMs = Math.max(
            intervalMs,
            retryDelay(response.headers["retry-after"], now)
          );

          next = now + retryAfterMs;

          return yield* new ExecutorError({
            code: "secondary-limit",
            message: "GitHub requested backoff",
            retryAfterMs,
          });
        }

        if (response.status === 404) {
          yield* receipts.append({
            missing: true,
            path: request.path,
            repo: request.repo,
            value: null,
          });

          return yield* new ExecutorError({
            code: "not-found",
            message: "GitHub resource not found",
          });
        }

        return yield* new ExecutorError({
          code: "provider",
          message: `GitHub returned HTTP ${response.status}`,
        });
      }, semaphore.withPermits(1));

      const attempts = Layer.succeed(ReadAttempt, { read });

      return GitHub.of({
        read: (repo, path) =>
          readWithBackoff(repo, path).pipe(Effect.provide(attempts)),
      });
    })
  );
