import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { TokenProvider } from "@joelhooks/piper-executor/token";
import {
  ConfigProvider,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Redacted,
  Result,
  Sink,
  Stream,
} from "effect";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import type { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { vi } from "vitest";

import { command } from "../src/command.js";
import { commandTokens } from "../src/token.js";

const secret = "synthetic-renewable-secret";

const commandPath = "/synthetic/token-command;literal";

const fakeCommand = (
  calls: ChildProcess.Command[],
  failAfter = Infinity,
  output = `  ${secret}\n`
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((invocation) =>
      Effect.sync(() => {
        calls.push(invocation);
        const stdout = Stream.make(new TextEncoder().encode(output));

        return ChildProcessSpawner.makeHandle({
          all: stdout,
          exitCode: Effect.succeed(
            ChildProcessSpawner.ExitCode(calls.length > failAfter ? 1 : 0)
          ),
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

const args = [
  "--repo",
  "sample/project",
  "--since",
  "2026-01-01T00:00:00Z",
  "--record",
  "/synthetic/recording",
  "--token-command",
  commandPath,
  "--token-ttl-ms",
  "1",
  "--read-interval-ms",
  "1",
];

const run = Command.runWith(command, { renderErrors: false, version: "0.2.0" });

const recordingFs = (files: Map<string, string>) =>
  FileSystem.layerNoop({
    chmod: () => Effect.void,
    exists: () => Effect.succeed(false),
    makeDirectory: () => Effect.void,
    realPath: (path) => Effect.succeed(path),
    writeFileString: (path, contents) =>
      Effect.sync(() => {
        files.set(path, contents);
      }),
  });

describe("renewable command tokens", () => {
  it.effect(
    "caches trimmed tokens and renews before expiry, including concurrent readers",
    () =>
      Effect.gen(function* test() {
        const calls: ChildProcess.Command[] = [];
        yield* TokenProvider.use((provider) =>
          Effect.gen(function* reads() {
            expect(Redacted.value(yield* provider.token)).toBe(secret);
            yield* TestClock.adjust(899);
            yield* provider.token;
            expect(calls).toHaveLength(1);
            yield* TestClock.adjust(1);
            yield* Effect.all([provider.token, provider.token], {
              concurrency: "unbounded",
            });
            expect(calls).toHaveLength(2);
            yield* TestClock.adjust(900);
            yield* provider.token;
            expect(calls).toHaveLength(3);
          })
        ).pipe(
          Effect.provide(
            commandTokens(commandPath, 1000).pipe(
              Layer.provide(fakeCommand(calls))
            )
          )
        );
        expect(calls[0]).toMatchObject({
          args: [],
          command: commandPath,
          options: { shell: false, stderr: "ignore", stdin: "ignore" },
        });
      })
  );

  it.effect("uses a fifty minute default lease", () =>
    Effect.gen(function* test() {
      const calls: ChildProcess.Command[] = [];
      yield* TokenProvider.use((provider) =>
        Effect.gen(function* reads() {
          yield* provider.token;
          yield* TestClock.adjust(2_699_999);
          yield* provider.token;
          expect(calls).toHaveLength(1);
          yield* TestClock.adjust(1);
          yield* provider.token;
          expect(calls).toHaveLength(2);
        })
      ).pipe(
        Effect.provide(
          commandTokens(commandPath).pipe(Layer.provide(fakeCommand(calls)))
        )
      );
    })
  );

  for (const output of ["", " \n", secret]) {
    it.effect(
      `rejects unsuccessful or empty mint output ${JSON.stringify(output)}`,
      () =>
        Effect.gen(function* test() {
          const result = yield* TokenProvider.use(
            (provider) => provider.token
          ).pipe(
            Effect.provide(
              commandTokens(commandPath).pipe(
                Layer.provide(
                  fakeCommand([], output === secret ? 0 : Infinity, output)
                )
              )
            ),
            Effect.result
          );

          expect(Result.isFailure(result)).toBe(true);
          expect(JSON.stringify(result)).not.toContain(commandPath);
          expect(JSON.stringify(result)).not.toContain(secret);
        })
    );
  }

  for (const ttl of [0, -1, 0.5, Infinity]) {
    it.effect(`rejects invalid TTL ${ttl} without spawning`, () =>
      Effect.gen(function* test() {
        const calls: ChildProcess.Command[] = [];

        const result = yield* TokenProvider.use(
          (provider) => provider.token
        ).pipe(
          Effect.provide(
            commandTokens(commandPath, ttl).pipe(
              Layer.provide(fakeCommand(calls))
            )
          ),
          Effect.result
        );

        expect(Result.isFailure(result)).toBe(true);
        expect(calls).toHaveLength(0);
      })
    );
  }

  for (const value of [secret]) {
    it.effect(
      `refuses an environment token with a command ${value.length}`,
      () =>
        Effect.gen(function* test() {
          const calls: ChildProcess.Command[] = [];

          const result = yield* run(args).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                recordingFs(new Map()),
                fakeCommand(calls),
                Layer.succeed(
                  ConfigProvider.ConfigProvider,
                  ConfigProvider.fromUnknown({ GITHUB_TOKEN: value })
                )
              )
            ),
            Effect.result
          );

          expect(Result.isFailure(result)).toBe(true);

          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({
              message:
                "--token-command and GITHUB_TOKEN are mutually exclusive",
            });
          }

          expect(calls).toHaveLength(0);
        })
    );
  }

  it.effect("replay never constructs or runs a command token provider", () =>
    Effect.gen(function* test() {
      const calls: ChildProcess.Command[] = [];
      yield* run([
        "--repo",
        "sample/project",
        "--since",
        "2026-01-01T00:00:00Z",
        "--replay",
        "packages/shadow/test/fixtures/clean",
        "--token-command",
        commandPath,
      ]).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            fakeCommand(calls),
            Layer.succeed(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ GITHUB_TOKEN: secret })
            )
          )
        )
      );
      expect(calls).toHaveLength(0);
    })
  );

  it.effect(
    "stops the real CLI on renewal failure and preserves successful reads without credentials",
    () =>
      Effect.gen(function* test() {
        const calls: ChildProcess.Command[] = [];
        const files = new Map<string, string>();

        const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
          Response.json([
            {
              base: { ref: "main", sha: "base" },
              body: null,
              created_at: "2026-01-01T00:00:00Z",
              draft: true,
              head: { ref: "train/1", sha: "head" },
              labels: [],
              merge_commit_sha: null,
              merged_at: null,
              node_id: "synthetic-node",
              number: 2,
              state: "open",
              user: { login: "synthetic-operator" },
            },
          ])
        );

        const fiber = yield* run(args).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              recordingFs(files),
              fakeCommand(calls, 1),
              Layer.succeed(FetchHttpClient.Fetch, fetch),
              Layer.succeed(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromUnknown({})
              )
            )
          ),
          Effect.result,
          Effect.forkChild
        );

        yield* TestClock.adjust(60_000);
        const result = yield* Fiber.join(fiber);
        expect(Result.isFailure(result)).toBe(true);
        expect(calls).toHaveLength(2);
        expect(fetch).toHaveBeenCalledTimes(1);
        const partial = files.get("/synthetic/recording/partial.json");
        expect(partial).toBeDefined();
        expect(JSON.parse(partial ?? "null")).toMatchObject({
          code: "read-stopped",
          reads: [{ missing: false, value: [{ head: { ref: "train/1" } }] }],
        });
        const recording = files.get("/synthetic/recording/train-1.json");
        expect(recording).toBeDefined();
        expect(JSON.parse(recording ?? "null")).toMatchObject({
          frames: [],
          input: { train: 1 },
        });
        expect(JSON.stringify([...files])).not.toContain(secret);
        expect(JSON.stringify([...files])).not.toContain(commandPath);
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(commandPath);
      })
  );
});
