import { expect, it } from "@effect/vitest";
import { TokenProvider } from "@joelhooks/piper-executor/token";
import { Effect, Layer, Redacted, Schema, Sink, Stream } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { commandTokens } from "../src/token.js";

it.effect.prop(
  "leases reuse a token strictly before ninety percent of TTL and renew once at the boundary",
  {
    lease: Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100_000, minimum: 1 }))
    ),
    text: Arbitrary.schema(Schema.NonEmptyString),
  },
  ({ lease, text }) =>
    Effect.gen(function* scenario() {
      let calls = 0;

      const token = new TextDecoder().decode(
        new TextEncoder().encode(`token-${text.trim()}-λ`)
      );

      const spawner = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.sync(() => {
            calls += 1;

            const stdout = Stream.make(
              new TextEncoder().encode(` \n${token}\t`)
            );

            return ChildProcessSpawner.makeHandle({
              all: stdout,
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              pid: ChildProcessSpawner.ProcessId(1),
              stderr: Stream.empty,
              stdin: Sink.drain,
              stdout,
              unref: Effect.succeed(Effect.void),
            });
          })
        )
      );

      yield* TokenProvider.use((provider) =>
        Effect.gen(function* reads() {
          expect(Redacted.value(yield* provider.token)).toBe(token);
          yield* TestClock.adjust(lease * 9 - 1);
          yield* provider.token;
          expect(calls).toBe(1);
          yield* TestClock.adjust(1);

          const tokens = yield* Effect.all(
            [provider.token, provider.token, provider.token],
            { concurrency: "unbounded" }
          );

          expect(tokens.map(Redacted.value)).toEqual([token, token, token]);
          expect(calls).toBe(2);
        })
      ).pipe(
        Effect.provide(
          commandTokens("/synthetic/token", lease * 10).pipe(
            Layer.provide(spawner)
          )
        )
      );
    })
);
