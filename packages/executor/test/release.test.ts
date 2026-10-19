import { describe, expect, it } from "@effect/vitest";
import type { ReleaseIntent } from "@joelhooks/piper/release-domain";
import {
  Clock,
  ConfigProvider,
  Data,
  Effect,
  Fiber,
  Layer,
  Predicate,
  Sink,
  Stream,
} from "effect";
import type { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import type { Job } from "../src/domain.js";
import { drain } from "../src/drain.js";
import { execute } from "../src/execute.js";
import { recover } from "../src/journal.js";
import {
  ReleaseCommandConfig,
  ReleaseCommands,
  ReleaseReviewer,
  releaseCommandsLayer,
  releaseWriters,
} from "../src/release.js";
import { dry, fake, live } from "./fakes.js";

const job = (
  intent: ReleaseIntent
): Extract<Job, { readonly _tag: "release" }> =>
  Data.taggedEnum<Job>().release({
    head: "commit-next",
    intent,
    repo: "sample/project",
    target: "release-synthetic",
  });

const stamp = { at: 1, id: "release-synthetic/1" };

const commands = {
  Deploy: { args: ["apply"], command: "deploy-command" },
  "Observe:availability": { args: [], command: "check-command" },
  "Observe:integrity": { args: [], command: "check-command" },
  PlanRelease: { args: ["plan"], command: "plan-command" },
  Restore: { args: [], command: "restore-command" },
};

const intents: readonly ReleaseIntent[] = [
  { ...stamp, kind: "PlanRelease", target: "commit-next" },
  {
    ...stamp,
    docs: { diff: "synthetic", spec: "synthetic" },
    kind: "RequestReview",
    plan: [{ action: "update", id: "literal; rm -rf", kind: "resource" }],
    runId: "release-synthetic",
  },
  { ...stamp, kind: "Deploy", target: "commit-next" },
  {
    ...stamp,
    checks: ["availability", "integrity"],
    deadlineAt: 1000,
    kind: "Observe",
  },
  { ...stamp, kind: "Restore", to: "commit-before" },
];

const admitted = Layer.succeed(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromUnknown({ PIPER_LIVE_ADMITTED_REPO: "sample/project" })
);

const spawner = (calls: ChildProcess.Command[], output: string, code = 0) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        calls.push(command);
        const stdout = Stream.make(new TextEncoder().encode(output));

        return ChildProcessSpawner.makeHandle({
          all: stdout,
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
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

const throwing = () => {
  throw new Error("live factory constructed in dry-run");
};

const completion = {
  Deploy: "deployed",
  PlanRelease: "planned",
  Restore: "restored",
};

describe("release executor command and judgment ports", () => {
  it.effect(
    "dry-run records every command and review payload, constructing no live spawner",
    () =>
      Effect.gen(function* dryRun() {
        const state = fake([]);

        for (const intent of intents) {
          const result = yield* execute(job(intent), dry).pipe(
            Effect.provide(
              Layer.mergeAll(
                state.layer,
                Layer.succeed(ReleaseCommandConfig, commands),
                releaseWriters("dry-run", throwing).pipe(
                  Layer.provide(spawner([], ""))
                )
              )
            )
          );

          expect(result.status).toBe("recorded-would-do");
          expect(result.events).toEqual([]);
        }

        expect(state.records.map((record) => record.kind)).toEqual(
          intents.map((intent) => intent.kind)
        );
        expect(
          state.records
            .flatMap((record) => record.wouldDo)
            .map((operation) => operation.path)
        ).toEqual([
          "plan-command",
          "RequestReview",
          "deploy-command",
          "check-command",
          "check-command",
          "restore-command",
        ]);
        expect(state.records[2]?.wouldDo[0]?.body).toEqual({
          args: ["apply", "--target", "commit-next"],
        });
      })
  );

  it.effect(
    "command adapter sends a configured literal argv with shell disabled; no row is a command",
    () =>
      Effect.gen(function* literalArgv() {
        const calls: ChildProcess.Command[] = [];

        const layer = releaseCommandsLayer.pipe(
          Layer.provide(spawner(calls, "[]"))
        );

        const literal = "row-value; rm -rf";
        yield* ReleaseCommands.use((runner) =>
          runner.run({ args: [literal], command: "synthetic-command" })
        ).pipe(Effect.provide(layer));
        expect(calls).toHaveLength(1);
        const [command] = calls;
        expect(command).toHaveProperty("command", "synthetic-command");
        expect(command).toHaveProperty("args", [literal]);
        expect(command).toHaveProperty("options.shell", false);
      })
  );

  it.effect(
    "live plan decodes rows; deploy and restore report completion only after exit",
    () =>
      Effect.gen(function* liveCommands() {
        for (const intent of intents.filter(
          (candidate) =>
            candidate.kind !== "RequestReview" && candidate.kind !== "Observe"
        )) {
          const calls: ChildProcess.Command[] = [];
          const state = fake([]);

          const result = yield* execute(job(intent), live).pipe(
            Effect.provide(
              Layer.mergeAll(
                state.layer,
                admitted,
                Layer.succeed(ReleaseCommandConfig, commands),
                releaseCommandsLayer.pipe(Layer.provide(spawner(calls, "[]")))
              )
            )
          );

          expect(result.status).toBe("done");
          expect(calls).toHaveLength(1);
          expect(result.events.map((event) => event._tag)).toEqual([
            completion[intent.kind],
          ]);
        }
      })
  );

  it.effect(
    "nonzero command exit and malformed plan output never report success",
    () =>
      Effect.gen(function* commandFailures() {
        for (const [kind, code, output] of [
          ["PlanRelease", 1, "[]"],
          ["Deploy", 1, ""],
          ["Restore", 1, ""],
          ["PlanRelease", 0, "invalid"],
        ] satisfies readonly [
          "PlanRelease" | "Deploy" | "Restore",
          number,
          string,
        ][]) {
          const state = fake([]);
          const calls: ChildProcess.Command[] = [];

          const intent: ReleaseIntent =
            kind === "Restore"
              ? { ...stamp, kind, to: "commit-before" }
              : { ...stamp, kind, target: "commit-next" };

          const result = yield* execute(job(intent), live).pipe(
            Effect.provide(
              Layer.mergeAll(
                state.layer,
                admitted,
                Layer.succeed(ReleaseCommandConfig, commands),
                releaseCommandsLayer.pipe(
                  Layer.provide(spawner(calls, output, code))
                )
              )
            )
          );

          expect(result.status).toBe("failed");
          expect(result.events.map((event) => event._tag)).toEqual(["failed"]);
        }
      })
  );

  it.effect(
    "observation deadline interrupts a hung command and starts no later check",
    () =>
      Effect.gen(function* hungCheck() {
        const state = fake([]);
        const now = yield* Clock.currentTimeMillis;
        let calls = 0;

        const deps = Layer.mergeAll(
          state.layer,
          admitted,
          Layer.succeed(ReleaseCommandConfig, commands),
          Layer.succeed(ReleaseCommands, {
            run: () =>
              Effect.suspend(() => {
                calls += 1;

                return Effect.never;
              }),
          })
        );

        const fiber = yield* execute(
          job({
            ...stamp,
            checks: ["availability", "integrity"],
            deadlineAt: now + 1000,
            kind: "Observe",
          }),
          live
        ).pipe(Effect.provide(deps), Effect.forkChild);

        yield* TestClock.adjust(1000);
        const result = yield* Fiber.join(fiber);
        expect(calls).toBe(1);
        expect(
          result.events.map((event) =>
            Predicate.isTagged(event, "observed") ? event.outcome : event._tag
          )
        ).toEqual(["unknown", "unknown"]);
      })
  );

  it.effect(
    "missing review holds; async submission returns no verdict and preserves the complete payload",
    () =>
      Effect.gen(function* review() {
        const state = fake([]);

        const intent: ReleaseIntent = {
          ...stamp,
          docs: { diff: "diff", spec: "spec" },
          kind: "RequestReview",
          plan: [],
          runId: "release-synthetic",
        };

        const missing = yield* execute(job(intent), live).pipe(
          Effect.provide(Layer.merge(state.layer, admitted))
        );

        expect(missing.events.map((event) => event._tag)).toEqual([
          "reviewUnavailable",
        ]);
        const submitted: unknown[] = [];

        const available = yield* execute(job(intent), live).pipe(
          Effect.provide(
            Layer.mergeAll(
              state.layer,
              admitted,
              Layer.succeed(ReleaseReviewer, {
                submit: (request) =>
                  Effect.sync(() => {
                    submitted.push(request);

                    return true;
                  }),
              })
            )
          )
        );

        expect(available.events).toEqual([]);
        expect(submitted).toEqual([
          { docs: intent.docs, plan: intent.plan, runId: intent.runId },
        ]);
      })
  );

  it.effect(
    "failed and malformed checks remain unknown, and a known failure is not erased",
    () =>
      Effect.gen(function* observations() {
        const state = fake([]);

        const result = yield* execute(
          job({
            ...stamp,
            checks: ["availability", "integrity"],
            deadlineAt: 1000,
            kind: "Observe",
          }),
          live
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              state.layer,
              admitted,
              Layer.succeed(ReleaseCommandConfig, commands),
              Layer.succeed(ReleaseCommands, {
                run: (command) =>
                  Effect.succeed(
                    command.args.includes("availability")
                      ? '{"outcome":"fail"}'
                      : "invalid json"
                  ),
              })
            )
          )
        );

        expect(
          result.events.map((event) =>
            Predicate.isTagged(event, "observed") ? event.outcome : event._tag
          )
        ).toEqual(["fail", "unknown"]);
      })
  );

  it.effect("live admission blocks all commands and review submissions", () =>
    Effect.gen(function* admission() {
      const state = fake([]);
      let calls = 0;

      const deps = Layer.mergeAll(
        state.layer,
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({})
        ),
        Layer.succeed(ReleaseCommandConfig, commands),
        Layer.succeed(ReleaseCommands, {
          run: () =>
            Effect.sync(() => {
              calls += 1;

              return "[]";
            }),
        })
      );

      const result = yield* execute(
        job({ ...stamp, kind: "Deploy", target: "commit-next" }),
        live
      ).pipe(Effect.provide(deps));

      expect(result.status).toBe("failed");
      expect(calls).toBe(0);
    })
  );

  it.effect(
    "a claimed deploy is never retried after a crash, and replayed completed deploy runs once",
    () =>
      Effect.gen(function* once() {
        const deploy = job({ ...stamp, kind: "Deploy", target: "commit-next" });

        for (const crash of [false, true]) {
          const state = fake([deploy]);
          let calls = 0;

          const deps = Layer.mergeAll(
            state.layer,
            admitted,
            Layer.succeed(ReleaseCommandConfig, commands),
            Layer.succeed(ReleaseCommands, {
              run: () =>
                Effect.suspend(() => {
                  calls += 1;

                  return crash
                    ? Effect.die("synthetic ambiguous acceptance")
                    : Effect.succeed("");
                }),
            })
          );

          yield* drain(live).pipe(Effect.exit, Effect.provide(deps));
          yield* recover().pipe(Effect.provide(state.layer));
          yield* drain(live).pipe(Effect.provide(deps));
          expect(calls).toBe(1);
          expect(
            state.posted.filter(Predicate.isTagged("deployed"))
          ).toHaveLength(crash ? 0 : 1);
        }
      })
  );
});
