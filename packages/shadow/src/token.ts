import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { TokenProvider } from "@joelhooks/piper-executor/token";
import { Clock, Effect, Layer, Redacted, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const commandTokens = (path: string, ttlMs = 3_000_000) =>
  Layer.effect(
    TokenProvider,
    Effect.gen(function* makeCommandTokens() {
      if (path.trim() === "" || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
        return yield* new ExecutorError({
          code: "configuration",
          message: "Expected a token command and a positive integer token TTL",
        });
      }

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const semaphore = yield* Semaphore.make(1);

      let cached:
        | { readonly value: Redacted.Redacted; readonly renewAt: number }
        | undefined;

      const mint = Effect.gen(function* mint() {
        const process = yield* spawner.spawn(
          ChildProcess.make(path, [], {
            shell: false,
            stderr: "ignore",
            stdin: "ignore",
          })
        );

        const output = yield* Stream.mkString(
          Stream.decodeText(process.stdout)
        );

        const code = yield* process.exitCode;

        if (code !== 0 || output.trim() === "") {
          return yield* new ExecutorError({
            code: "missing-token",
            message: "Token command failed to mint a nonempty token",
          });
        }

        return Redacted.make(output.trim());
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          () =>
            new ExecutorError({
              code: "missing-token",
              message: "Token command failed; provider details withheld",
            })
        )
      );

      return TokenProvider.of({
        token: Effect.gen(function* leasedToken() {
          const now = yield* Clock.currentTimeMillis;

          if (cached !== undefined && now < cached.renewAt) {
            return cached.value;
          }

          const value = yield* mint;
          cached = { renewAt: now + ttlMs * 0.9, value };

          return value;
        }).pipe(semaphore.withPermits(1)),
      });
    })
  );
