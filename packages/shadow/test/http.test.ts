import { describe, expect, it } from "@effect/vitest";
import { GitHub } from "@joelhooks/piper-executor/github";
import { TokenProvider } from "@joelhooks/piper-executor/token";
import { Clock, Effect, Fiber, Layer, Match, Redacted, Result } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type { RawRead } from "../src/domain.js";
import { retryDelay, ReadReceipts, shadowGitHub } from "../src/http.js";

const token = Redacted.make("synthetic-token");

const receipts = (reads: RawRead[]) =>
  Layer.succeed(ReadReceipts, {
    append: (read) =>
      Effect.sync(() => {
        reads.push(read);
      }),
  });

type Reply = "offline" | number;

const scripted = (replies: readonly Reply[], times: number[]) =>
  HttpClient.make((request) =>
    Effect.gen(function* respond() {
      times.push(yield* Clock.currentTimeMillis);
      expect(request.method).toBe("GET");
      const reply = replies[Math.min(times.length, replies.length) - 1];

      return yield* reply === "offline" || reply === undefined
        ? Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            })
          )
        : Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ sha: "synthetic-head" }, { status: reply })
            )
          );
    })
  );

const scriptedRead = (replies: readonly Reply[]) =>
  Effect.gen(function* run() {
    const times: number[] = [];
    const reads: RawRead[] = [];

    const layer = shadowGitHub().pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, scripted(replies, times)),
          TokenProvider.fromValue(token, 3_600_000),
          receipts(reads)
        )
      )
    );

    const fiber = yield* GitHub.use((github) =>
      github.read("sample/project", "/git/ref/heads/main")
    ).pipe(Effect.provide(layer), Effect.result, Effect.forkChild);

    yield* TestClock.adjust("1 minute");
    const result = yield* Fiber.join(fiber);

    return { reads, result, times };
  });

describe("transient read retry", () => {
  it.effect("returns the value after a transport failure", () =>
    Effect.gen(function* test() {
      const { reads, result, times } = yield* scriptedRead(["offline", 200]);

      expect(result).toEqual(Result.succeed({ sha: "synthetic-head" }));
      expect(times).toEqual([0, 500]);
      expect(reads).toHaveLength(1);
    })
  );

  it.effect("returns the value after three 503 responses", () =>
    Effect.gen(function* test() {
      const { reads, result, times } = yield* scriptedRead([
        503, 503, 503, 200,
      ]);

      expect(result).toEqual(Result.succeed({ sha: "synthetic-head" }));
      expect(times).toEqual([0, 500, 1500, 3500]);
      expect(reads).toHaveLength(1);
    })
  );

  it.effect(
    "returns the transport error after the bounded retries of a persistent failure",
    () =>
      Effect.gen(function* test() {
        const { reads, result, times } = yield* scriptedRead(["offline"]);

        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            code: "transport",
            message: "Shadow GET failed; provider details withheld",
          });
        }

        expect(times).toEqual([0, 500, 1500, 3500, 6500]);
        expect(reads).toEqual([]);
      })
  );

  it.effect("reports the last 5xx as a provider error after the retries", () =>
    Effect.gen(function* test() {
      const { result, times } = yield* scriptedRead([502]);

      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          code: "provider",
          message: "GitHub returned HTTP 502",
        });
      }

      expect(times).toHaveLength(5);
    })
  );

  it.effect("does not retry a 404", () =>
    Effect.gen(function* test() {
      const { reads, result, times } = yield* scriptedRead([404, 200]);

      expect(Result.isFailure(result)).toBe(true);

      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({ code: "not-found" });
      }

      expect(times).toEqual([0]);
      expect(reads).toMatchObject([{ missing: true }]);
    })
  );
});

describe("shared GitHub rate budget", () => {
  it.effect(
    "stops non-retryably below the configured fraction and preserves the last read without credentials",
    () =>
      Effect.gen(function* test() {
        const reads: RawRead[] = [];
        let count = 0;

        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            count += 1;
            expect(request.method).toBe("GET");

            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                { sha: "synthetic-head" },
                {
                  headers: {
                    "x-ratelimit-limit": "100",
                    "x-ratelimit-remaining": "19",
                  },
                  status: 200,
                }
              )
            );
          })
        );

        const layer = shadowGitHub().pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, client),
              TokenProvider.fromValue(token, 3_600_000),
              receipts(reads)
            )
          )
        );

        const result = yield* GitHub.use((github) =>
          github.read("sample/project", "/git/ref/heads/main")
        ).pipe(Effect.provide(layer), Effect.result);

        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ code: "secondary-limit" });
          expect(result.failure.retryAfterMs).toBeUndefined();
        }

        expect(count).toBe(1);
        expect(reads).toMatchObject([
          { path: "/git/ref/heads/main", value: { sha: "synthetic-head" } },
        ]);
        expect(JSON.stringify(reads)).not.toContain(Redacted.value(token));
      })
  );

  it.effect(
    "honours Retry-After on 403/429 and the shared minimum request interval",
    () =>
      Effect.gen(function* test() {
        const times: number[] = [];
        const methods: string[] = [];

        const client = HttpClient.make((request) =>
          Effect.gen(function* respond() {
            times.push(yield* Clock.currentTimeMillis);
            methods.push(request.method);

            const status = Match.value(times.length).pipe(
              Match.when(1, () => 403),
              Match.when(2, () => 429),
              Match.orElse(() => 200)
            );

            return HttpClientResponse.fromWeb(
              request,
              new Response("{}", {
                headers: {
                  "retry-after": "3",
                  "x-ratelimit-limit": "100",
                  "x-ratelimit-remaining": "90",
                },
                status,
              })
            );
          })
        );

        const layer = shadowGitHub().pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HttpClient.HttpClient, client),
              TokenProvider.fromValue(token, 3_600_000),
              receipts([])
            )
          )
        );

        const program = GitHub.use((github) =>
          Effect.gen(function* calls() {
            yield* github.read("sample/project", "/a");
            yield* github.read("sample/project", "/b");
          })
        );

        const fiber = yield* program.pipe(
          Effect.provide(layer),
          Effect.forkChild
        );

        yield* TestClock.adjust(2999);
        expect(times).toHaveLength(1);
        yield* TestClock.adjust(1);
        expect(times).toHaveLength(2);
        yield* TestClock.adjust(3000);
        expect(times).toHaveLength(3);
        yield* TestClock.adjust(1999);
        expect(times).toHaveLength(3);
        yield* TestClock.adjust(1);
        yield* Fiber.join(fiber);
        expect(times).toEqual([0, 3000, 6000, 8000]);
        expect(methods).toEqual(["GET", "GET", "GET", "GET"]);
        expect(retryDelay("Thu, 01 Jan 1970 00:00:09 GMT", 8000)).toBe(1000);
      })
  );
});
