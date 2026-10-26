import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import type {
  PostedReleaseEvent,
  ReleaseIntent,
} from "@joelhooks/piper/release-domain";
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

const releaseEvents = Data.taggedEnum<PostedReleaseEvent>();

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
  {
    ...stamp,
    checks: [
      { name: "availability", onFail: "restore" },
      { name: "integrity", onFail: "escalate" },
    ],
    kind: "Baseline",
  },
  { ...stamp, kind: "Deploy", target: "commit-next" },
  {
    ...stamp,
    checks: [
      { name: "availability", onFail: "restore" },
      { name: "integrity", onFail: "escalate" },
    ],
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
    "baselines reuse observe mappings, append literal baseline arguments and post every result",
    () =>
      Effect.gen(function* baselines() {
        for (const [output, outcome] of [
          ['{"outcome":"pass"}', "pass"],
          ['{"outcome":"fail"}', "fail"],
          ['{"outcome":"unknown"}', "unknown"],
          ['{"outcome":"breach"}', "unknown"],
          ["invalid", "unknown"],
        ] satisfies readonly [string, "pass" | "fail" | "unknown"][]) {
          const state = fake([]);
          const calls: unknown[] = [];

          const result = yield* execute(
            job({
              ...stamp,
              checks: [
                { name: "availability", onFail: "restore" },
                { name: "integrity", onFail: "escalate" },
              ],
              kind: "Baseline",
            }),
            live
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                state.layer,
                admitted,
                Layer.succeed(ReleaseCommandConfig, {
                  ...commands,
                  "Observe:availability": {
                    args: ["configured"],
                    command: "mapped-baseline",
                  },
                }),
                Layer.succeed(ReleaseCommands, {
                  run: (command) =>
                    Effect.sync(() => {
                      calls.push(command);

                      return output;
                    }),
                })
              )
            )
          );

          expect(result.status).toBe("done");
          expect(calls).toEqual([
            {
              args: ["configured", "--check", "availability", "--baseline"],
              command: "mapped-baseline",
            },
            {
              args: ["--check", "integrity", "--baseline"],
              command: "check-command",
            },
          ]);
          expect(result.events).toEqual([
            releaseEvents.baselined({ at: 0, check: "availability", outcome }),
            releaseEvents.baselined({ at: 0, check: "integrity", outcome }),
          ]);
        }
      })
  );

  it.effect(
    "baseline command failures and absent mappings become unknown without erasing later checks",
    () =>
      Effect.gen(function* baselineFailures() {
        const state = fake([]);
        const calls: ChildProcess.Command[] = [];

        const result = yield* execute(
          job({
            ...stamp,
            checks: [
              { name: "missing", onFail: "restore" },
              { name: "availability", onFail: "restore" },
              { name: "integrity", onFail: "escalate" },
            ],
            kind: "Baseline",
          }),
          live
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              state.layer,
              admitted,
              Layer.succeed(ReleaseCommandConfig, commands),
              releaseCommandsLayer.pipe(Layer.provide(spawner(calls, "", 1)))
            )
          )
        );

        expect(result.status).toBe("done");
        expect(calls).toHaveLength(2);
        expect(result.events).toEqual(
          ["missing", "availability", "integrity"].map((check) =>
            releaseEvents.baselined({ at: 0, check, outcome: "unknown" })
          )
        );
      })
  );

  it.effect(
    "owner notifications use literal arguments, honor dry-run, and emit no machine events",
    () =>
      Effect.gen(function* notifications() {
        for (const intent of [
          {
            ...stamp,
            cause: "observationFailed",
            check: "availability",
            kind: "NotifyOwner",
          },
          {
            ...stamp,
            cause: "observationPreexisting",
            check: "integrity",
            kind: "NotifyOwner",
          },
          { ...stamp, cause: "deployFailed", kind: "NotifyOwner" },
          { ...stamp, cause: "observationExpired", kind: "NotifyOwner" },
          {
            ...stamp,
            cause: "observationBuildFailed",
            check: "availability",
            deploymentId: "deployment-failed",
            deploymentState: "CANCELED",
            kind: "NotifyOwner",
          },
        ] satisfies readonly ReleaseIntent[]) {
          for (const settings of [dry, live]) {
            const state = fake([]);
            const calls: unknown[] = [];

            const named =
              "check" in intent
                ? ["--cause", intent.cause, "--check", intent.check]
                : ["--cause", intent.cause];

            const args =
              "deploymentId" in intent
                ? [
                    ...named,
                    "--deployment",
                    intent.deploymentId,
                    "--deployment-state",
                    intent.deploymentState,
                  ]
                : named;

            const result = yield* execute(job(intent), settings).pipe(
              Effect.provide(
                Layer.mergeAll(
                  state.layer,
                  admitted,
                  Layer.succeed(ReleaseCommandConfig, {
                    NotifyOwner: { args: [], command: "notify-command" },
                  }),
                  Layer.succeed(ReleaseCommands, {
                    run: (command) =>
                      Effect.sync(() => {
                        calls.push(command);

                        return "";
                      }),
                  })
                )
              )
            );

            expect(result.events).toEqual([]);
            expect(result.status).toBe(
              settings.mode === "dry-run" ? "recorded-would-do" : "done"
            );
            expect(calls).toEqual(
              settings.mode === "dry-run"
                ? []
                : [{ args, command: "notify-command" }]
            );
          }
        }
      })
  );

  it.effect(
    "check commands carry build-failed and superseded words and their detail to core; malformed words stay unknown",
    () =>
      Effect.gen(function* releaseWords() {
        const buildFailed = {
          deploymentId: "deployment-failed",
          outcome: "build-failed",
          state: "CANCELED",
          url: "build.sample.test",
        };

        const superseded = {
          by: "commit-newer",
          deploymentId: "deployment-newer",
          outcome: "superseded",
        };

        for (const [line, expected] of [
          [
            `diagnostic\n${JSON.stringify(buildFailed)}`,
            releaseEvents.observed({
              at: 0,
              check: "availability",
              deploymentId: "deployment-failed",
              deploymentState: "CANCELED",
              detail: {
                deploymentId: "deployment-failed",
                state: "CANCELED",
                url: "build.sample.test",
              },
              outcome: "build-failed",
            }),
          ],
          [
            JSON.stringify(superseded),
            releaseEvents.observed({
              at: 0,
              by: "commit-newer",
              check: "availability",
              deploymentId: "deployment-newer",
              detail: { by: "commit-newer", deploymentId: "deployment-newer" },
              outcome: "superseded",
            }),
          ],
          ...[
            { outcome: "build-failed" },
            { ...buildFailed, deploymentId: "" },
            { ...buildFailed, state: "READY" },
            { deploymentId: "deployment-failed", outcome: "build-failed" },
            { deploymentId: "deployment-newer", outcome: "superseded" },
            { ...superseded, by: "" },
            { by: "commit-newer", outcome: "superseded" },
            { ...superseded, outcome: "retired" },
          ].map((malformed): [string, PostedReleaseEvent] => [
            JSON.stringify(malformed),
            releaseEvents.observed({
              at: 0,
              check: "availability",
              detail: {},
              outcome: "unknown",
            }),
          ]),
        ] satisfies readonly [string, PostedReleaseEvent][]) {
          const state = fake([]);

          const result = yield* execute(
            job({
              ...stamp,
              checks: [{ name: "availability", onFail: "restore" }],
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
                  run: () => Effect.succeed(line),
                })
              )
            )
          );

          expect(result.events, line).toEqual([expected]);
        }
      })
  );

  it.effect("check commands preserve hard breach outcomes", () =>
    Effect.gen(function* breach() {
      const state = fake([]);

      const result = yield* execute(
        job({
          ...stamp,
          checks: [{ name: "availability", onFail: "escalate" }],
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
              run: () => Effect.succeed('{"outcome":"breach"}'),
            })
          )
        )
      );

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toMatchObject({
        at: 0,
        check: "availability",
        outcome: "breach",
      });
      expect(result.events[0]?._tag).toBe("observed");
    })
  );
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
          "check-command",
          "check-command",
          "deploy-command",
          "check-command",
          "check-command",
          "restore-command",
        ]);
        expect(
          state.records[2]?.wouldDo.map((operation) => operation.body)
        ).toEqual([
          { args: ["--check", "availability", "--baseline"] },
          { args: ["--check", "integrity", "--baseline"] },
        ]);
        expect(state.records[3]?.wouldDo[0]?.body).toEqual({
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
            candidate.kind !== "RequestReview" &&
            candidate.kind !== "Baseline" &&
            candidate.kind !== "Observe" &&
            candidate.kind !== "NotifyOwner"
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
            checks: [
              { name: "availability", onFail: "restore" },
              { name: "integrity", onFail: "escalate" },
            ],
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
            checks: [
              { name: "availability", onFail: "restore" },
              { name: "integrity", onFail: "escalate" },
            ],
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

  it.effect(
    "a failing command reports its exit code and the tail of its stderr",
    () =>
      Effect.gen(function* failingCommand() {
        const script = [
          "for i in $(seq 1 30); do echo noise-$i >&2; done",
          "echo refused: expected one assignment >&2",
          "exit 3",
        ].join("; ");

        const error = yield* ReleaseCommands.use((runner) =>
          runner.run({ args: ["-c", script], command: "sh" })
        ).pipe(
          Effect.flip,
          Effect.provide(
            releaseCommandsLayer.pipe(Layer.provide(NodeServices.layer))
          )
        );

        expect(error.code).toBe("provider");
        expect(error.message).toContain("code 3");
        expect(error.message).toContain("refused: expected one assignment");
        expect(error.message).toContain("noise-30");
        expect(error.message).not.toContain("noise-9\n");
        expect(error.message).not.toContain("noise-1:");
        expect(error.message.length).toBeLessThan(2200);
      })
  );

  it.effect("a command that cannot be spawned says so", () =>
    Effect.gen(function* missingCommand() {
      const error = yield* ReleaseCommands.use((runner) =>
        runner.run({ args: [], command: "synthetic-missing-command" })
      ).pipe(
        Effect.flip,
        Effect.provide(
          releaseCommandsLayer.pipe(Layer.provide(NodeServices.layer))
        )
      );

      expect(error.message).toContain("failed to spawn");
    })
  );
});
