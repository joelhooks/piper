import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Redacted } from "effect";

import { runAdmitted } from "../src/admission.js";
import { TokenProvider } from "../src/token.js";
import { Transport } from "../src/transport.js";
import { GitHubWrites } from "../src/writes.js";
import { HEAD, train } from "./fakes.js";

const fixture = () => {
  const counts = { requests: 0, tokens: 0, writers: 0 };

  const build = () => {
    counts.writers += 1;

    const tokens = Layer.succeed(TokenProvider, {
      token: Effect.sync(() => {
        counts.tokens += 1;

        return Redacted.make("synthetic-token");
      }),
    });

    const transport = Layer.succeed(Transport, {
      request: () =>
        Effect.sync(() => {
          counts.requests += 1;

          return null;
        }),
    });

    const layer = GitHubWrites.live().pipe(
      Layer.provide(Layer.merge(tokens, transport))
    );

    const job = train({
      at: 1,
      id: "train-1/1",
      kind: "Merge",
      matchHead: HEAD,
      pr: 3,
    });

    return GitHubWrites.use((github) =>
      github.write(job, {
        body: { sha: HEAD },
        method: "PUT",
        path: "/pulls/3/merge",
      })
    ).pipe(Effect.provide(layer));
  };

  return { build, counts };
};

describe("live repository admission", () => {
  it.effect(
    "missing or different admission builds no writer, reads no token and makes zero requests",
    () =>
      Effect.gen(function* rejected() {
        for (const admission of [
          undefined,
          "sample/other",
          "Sample/project",
          "sample/project ",
        ]) {
          const provider = ConfigProvider.fromUnknown(
            admission === undefined
              ? {}
              : { PIPER_LIVE_ADMITTED_REPO: admission }
          );

          const candidate = fixture();

          const result = yield* runAdmitted(
            "live",
            "sample/project",
            candidate.build
          ).pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, provider),
            Effect.result
          );

          expect(candidate.counts).toEqual({
            requests: 0,
            tokens: 0,
            writers: 0,
          });
          expect(result).toHaveProperty("failure.code", "configuration");
        }
      })
  );

  it.effect(
    "exact admission permits construction and dry-run ignores a different admission",
    () =>
      Effect.gen(function* accepted() {
        const candidate = fixture();
        yield* runAdmitted("live", "sample/project", candidate.build).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              PIPER_LIVE_ADMITTED_REPO: "sample/project",
            })
          )
        );
        expect(candidate.counts).toEqual({
          requests: 1,
          tokens: 1,
          writers: 1,
        });
        let entered = false;
        yield* runAdmitted("dry-run", "sample/project", () =>
          Effect.sync(() => {
            entered = true;
          })
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              PIPER_LIVE_ADMITTED_REPO: "sample/other",
            })
          )
        );
        expect(entered).toBe(true);
      })
  );
});
