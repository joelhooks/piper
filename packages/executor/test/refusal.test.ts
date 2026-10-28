import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { classifyRefusal, Transport } from "../src/transport.js";

const body = (message: string) => JSON.stringify({ message });

const attempt = (
  status: number,
  headers: Record<string, string>,
  text: string
) =>
  Effect.gen(function* run() {
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(text, { headers, status })
        )
      )
    );

    const request = Effect.gen(function* send() {
      const transport = yield* Transport;

      return yield* transport
        .request({
          method: "POST",
          token: Redacted.make("synthetic"),
          url: "https://provider.invalid/write",
        })
        .pipe(Effect.asVoid, Effect.flip);
    });

    return yield* request.pipe(
      Effect.provide(
        Transport.layer(1).pipe(
          Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
        )
      )
    );
  });

describe("refused writes", () => {
  it.effect("a 429 is a secondary limit with a delay", () =>
    Effect.gen(function* test() {
      const error = yield* attempt(429, {}, body("slow down"));
      expect(error.code).toBe("secondary-limit");
      expect(error.retryAfterMs).toBe(60_000);
    })
  );

  it.effect("a retry-after header is a secondary limit", () =>
    Effect.gen(function* test() {
      const error = yield* attempt(403, { "retry-after": "90" }, body("no"));
      expect(error.code).toBe("secondary-limit");
      expect(error.retryAfterMs).toBe(90_000);
    })
  );

  it.effect("an exhausted rate budget is a secondary limit", () =>
    Effect.gen(function* test() {
      const error = yield* attempt(
        403,
        { "x-ratelimit-remaining": "0" },
        body("no")
      );

      expect(error.code).toBe("secondary-limit");
    })
  );

  it.effect("rate limit and abuse messages are secondary limits", () =>
    Effect.gen(function* test() {
      for (const message of [
        "You have exceeded a secondary rate limit",
        "Abuse detection mechanism triggered",
      ]) {
        const error = yield* attempt(403, {}, body(message));
        expect(error.code).toBe("secondary-limit");
      }
    })
  );

  it.effect("a run that cannot be retried is not retryable", () =>
    Effect.gen(function* test() {
      for (const message of [
        "This workflow run cannot be retried",
        "This workflow run cannot be rerun",
      ]) {
        const error = yield* attempt(403, {}, body(message));
        expect(error.code).toBe("not-retryable");
        expect(error.message).toBe(message);
        expect(error.retryAfterMs).toBeUndefined();
      }
    })
  );

  it.effect("a 403 without hints is refused and does not throttle", () =>
    Effect.gen(function* test() {
      const error = yield* attempt(403, {}, body("Resource not accessible"));
      expect(error.code).toBe("refused");
      expect(error.message).toBe("Resource not accessible");
      expect(error.retryAfterMs).toBeUndefined();
    })
  );

  it.effect("an unreadable body is refused with a generic message", () =>
    Effect.gen(function* test() {
      const error = yield* attempt(403, {}, "<html>");
      expect(error.code).toBe("refused");
      expect(error.message).not.toBe("");
    })
  );

  it("the provider message is capped", () => {
    const refusal = classifyRefusal(403, {}, body("x".repeat(500)));
    expect(refusal).toMatchObject({ code: "refused" });
    expect("message" in refusal && refusal.message).toHaveLength(200);
  });
});
