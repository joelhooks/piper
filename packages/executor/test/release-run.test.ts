import { fileURLToPath } from "node:url";

import {
  NodeCrypto,
  NodeFileSystem,
  NodeServices,
} from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { createEffectActor, snapshots, waitFor } from "@xstate/effect";
import {
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Predicate,
  Queue,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import { releaseInput } from "../../core/test/release-fixtures.js";
import { ExecutorError } from "../src/domain.js";
import { Recorder } from "../src/recorder.js";
import { releaseCheckMachine } from "../src/release-check.js";
import {
  AdmissionSchema,
  ReleaseConfigSchema,
  RunLogLineSchema,
} from "../src/release-run-domain.js";
import type { ReleaseConfig, VerdictRow } from "../src/release-run-domain.js";
import { runLines } from "../src/release-run-log.js";
import {
  releaseAdmissionRefusal,
  releaseConfigRefusal,
} from "../src/release-run-policy.js";
import {
  MessageSink,
  ReadyStore,
  RunLog,
  VerdictSink,
  printOnlyReleaseLayer,
  releaseMemoryStore,
  releaseSinkLayer,
  releaseFileStore,
  liveFireSinks,
  makeVerdictMemory,
} from "../src/release-run-services.js";
import {
  decodeReleaseConfig,
  releaseDriverMachine,
  runRelease,
} from "../src/release-run.js";
import type { ReleaseRunOptions } from "../src/release-run.js";
import { ReleaseCommands, ReleaseCommandConfig } from "../src/release.js";
import type { ReleaseCommandSchema } from "../src/release.js";

const config: ReleaseConfig = {
  commands: {
    Deploy: { args: [], command: "deploy" },
    MessageOwner: { args: [], command: "message" },
    NotifyOwner: { args: [], command: "notify" },
    "Observe:availability": { args: [], command: "availability" },
    "Observe:integrity": { args: [], command: "integrity" },
    PageOwner: { args: [], command: "page" },
    PlanRelease: { args: [], command: "plan" },
    Restore: { args: [], command: "restore" },
  },
  input: {
    ...releaseInput,
    checks: [
      { everyMs: 10, name: "availability", onFail: "restore", timeoutMs: 100 },
      { everyMs: 30, name: "integrity", onFail: "escalate", timeoutMs: 100 },
    ],
    minimumRunwayMs: 1,
    observationTimeoutMs: 100,
  },
  name: "synthetic-release",
  predecessor: "accepted",
  preflight: { args: [], command: "preflight" },
  repo: "sample/project",
  rowPrefix: "synthetic: ",
};

const options: ReleaseRunOptions = {
  action: "fire",
  admission: {
    by: "operator",
    override: false,
    verdict: "approve",
    words: "I approve this code-only plan.",
  },
  admittedRepo: "sample/project",
  mode: "live",
};

const rows = [{ action: "update", id: "resource-a", kind: "resource" }];

const harness = Effect.gen(function* harness() {
  const store = yield* releaseMemoryStore;
  const messages: string[] = [];
  const pages: string[] = [];
  const verdicts: VerdictRow[] = [];
  const calls: string[] = [];
  const observed = yield* Queue.unbounded<string>();

  const controls = {
    drift: false,
    failNotify: false,
    failPreflight: false,
    invalidPlan: false,
    line: "",
    outcome: "pass",
    planCrash: false,
    slow: false,
  };

  const runner = Layer.succeed(ReleaseCommands, {
    run: Effect.fn("TestRelease.run")(function* run(
      command: typeof ReleaseCommandSchema.Type
    ) {
      calls.push(command.command);

      if (
        (command.command === "preflight" && controls.failPreflight) ||
        (command.command === "notify" && controls.failNotify) ||
        (command.command === "plan" && controls.planCrash)
      ) {
        return yield* new ExecutorError({
          code: "provider",
          message: "synthetic command failure",
        });
      }

      if (command.command === "plan") {
        if (
          controls.drift &&
          calls.filter((call) => call === "plan").length >= 3
        ) {
          return JSON.stringify([
            ...rows,
            { action: "update", id: "resource-b", kind: "resource" },
          ]);
        }

        return JSON.stringify(
          controls.invalidPlan
            ? [{ action: "delete", id: "resource-a", kind: "resource" }]
            : rows
        );
      }

      if (
        command.command === "availability" ||
        command.command === "integrity"
      ) {
        if (command.args.includes("--baseline")) {
          return JSON.stringify({ outcome: "pass" });
        }

        if (controls.slow && command.command === "integrity") {
          return yield* Effect.never;
        }

        const line =
          controls.line === ""
            ? JSON.stringify({
                evidence: `${command.command}-evidence`,
                outcome: controls.outcome,
              })
            : controls.line;

        return `diagnostic line\n${line}\n`;
      }

      return "OK";
    }),
  });

  const sinks = Layer.mergeAll(
    Layer.succeed(MessageSink, {
      page: (message) =>
        Effect.sync(() => {
          pages.push(message);
        }),
      send: (message) =>
        Effect.sync(() => {
          messages.push(message);
        }).pipe(Effect.andThen(Queue.offer(observed, message)), Effect.asVoid),
    }),
    Layer.succeed(VerdictSink, {
      write: (row) =>
        Effect.sync(() => {
          verdicts.push(row);
        }),
    }),
    Layer.succeed(Recorder, { append: () => Effect.void })
  );

  const layer = Layer.mergeAll(
    store,
    runner,
    sinks,
    NodeCrypto.layer,
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ PIPER_LIVE_ADMITTED_REPO: config.repo })
    )
  );

  return { calls, controls, layer, messages, observed, pages, verdicts };
});

const ready = (value = config) =>
  runRelease(value, { ...options, action: "ready" });

const fire = Effect.fn("TestRelease.fire")(function* fire(
  test: Effect.Success<typeof harness>,
  value: ReleaseConfig = config,
  runOptions: ReleaseRunOptions = options
) {
  yield* ready(value);
  const fiber = yield* runRelease(value, runOptions).pipe(Effect.forkScoped);
  yield* Queue.take(test.observed).pipe(
    Effect.repeat({ until: (line) => line.endsWith(": observing") })
  );
  yield* TestClock.adjust(100);

  return yield* Fiber.join(fiber);
});

describe("release host", () => {
  it.effect("CLI ready and dry fire cannot execute configured live sinks", () =>
    Effect.gen(function* cliDryRun() {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "piper-release-cli-",
      });

      const marker = `${directory}/live-sink-called`;

      const forbidden = {
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called")`,
          "--",
        ],
        command: process.execPath,
      };

      const input: ReleaseConfig = {
        ...config,
        commands: {
          ...config.commands,
          Deploy: forbidden,
          MessageOwner: forbidden,
          NotifyOwner: forbidden,
          PageOwner: forbidden,
          PlanRelease: {
            args: [
              "-e",
              `process.stdout.write(${JSON.stringify(JSON.stringify(rows))})`,
              "--",
            ],
            command: process.execPath,
          },
        },
        preflight: {
          args: ["-e", "process.exit(0)"],
          command: process.execPath,
        },
      };

      const path = `${directory}/config.json`;
      const state = `${directory}/state`;
      const verdicts = `${directory}/verdicts.tsv`;
      yield* fs.writeFileString(path, JSON.stringify(input));

      const commands = [
        ["release", "ready", path, "--state", state],
        [
          "release",
          "fire",
          path,
          "--state",
          state,
          "--verdicts",
          verdicts,
          "--mode",
          "dry-run",
          "--by",
          "operator",
          "--verdict",
          "approve",
          "--words",
          "Synthetic operator approval.",
        ],
      ];

      for (const args of commands) {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            fileURLToPath(new URL("../bin/piper-executor", import.meta.url)),
            args,
            {
              env: { PIPER_LIVE_ADMITTED_REPO: config.repo },
              extendEnv: true,
              stderr: "pipe",
              stdin: "ignore",
            }
          )
        );

        const output = yield* Stream.mkString(Stream.decodeText(child.stdout));
        const errors = yield* Stream.mkString(Stream.decodeText(child.stderr));
        expect(yield* child.exitCode, `${errors}\n${output}`).toBe(0);
      }

      expect(yield* fs.exists(`${state}/READY`)).toBe(true);
      expect(yield* fs.exists(marker)).toBe(false);
      expect(yield* fs.exists(verdicts)).toBe(false);
      const log = yield* fs.readFileString(`${state}/run.jsonl`);
      expect(log).toContain('"_tag":"would-do"');
      expect(log).not.toContain('"kind":"Deploy"');
    }).pipe(Effect.provide(NodeServices.layer))
  );

  it.effect(
    "accepts, preserves command details and records one verdict per settled check",
    () =>
      Effect.gen(function* accepted() {
        const test = yield* harness;
        yield* Effect.gen(function* run() {
          const result = yield* fire(test);
          expect(result.state).toBe("accepted");
          expect(test.verdicts.map((row) => row.step).toSorted()).toEqual([
            "availability",
            "integrity",
          ]);
          expect(test.verdicts[0]?.evidence).toContain("availability-evidence");
          expect(test.pages).toEqual([]);
          const log = yield* RunLog;
          const lines = yield* log.lines;
          expect(
            lines.some(
              (line) =>
                Predicate.isTagged(line, "admission") &&
                line.admission.words === options.admission.words
            )
          ).toBe(true);

          for (const line of lines) {
            yield* Schema.encodeEffect(Schema.fromJsonString(RunLogLineSchema))(
              line
            );
          }

          expect(test.messages.at(-1)).toBe("finished: accepted");
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect("holds and pages when the operator holds without override", () =>
    Effect.gen(function* held() {
      const test = yield* harness;
      yield* Effect.gen(function* run() {
        yield* ready();

        const result = yield* runRelease(config, {
          ...options,
          admission: { ...options.admission, verdict: "hold" },
        });

        expect(result.state).toBe("held");
        expect(test.pages).toHaveLength(1);
        expect(test.calls).not.toContain("deploy");
      }).pipe(Effect.provide(test.layer));
    })
  );

  it.effect(
    "expires unknown checks at the deadline, pages and writes no unknown verdict",
    () =>
      Effect.gen(function* expired() {
        const test = yield* harness;
        test.controls.outcome = "unknown";
        yield* Effect.gen(function* run() {
          const result = yield* fire(test);
          expect(result.state).toBe("escalated");
          expect(test.pages).toHaveLength(1);
          expect(test.verdicts).toEqual([]);
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect(
    "a slow check does not delay a fast check's cadence or settlement",
    () =>
      Effect.gen(function* cadence() {
        const test = yield* harness;
        test.controls.slow = true;
        yield* Effect.gen(function* run() {
          yield* ready();

          const fiber = yield* runRelease(config, options).pipe(
            Effect.forkScoped
          );

          yield* Queue.take(test.observed).pipe(
            Effect.repeat({ until: (line) => line.endsWith(": observing") })
          );
          yield* TestClock.adjust(20);
          expect(test.verdicts.map((row) => row.step)).toEqual([
            "availability",
          ]);
          yield* TestClock.adjust(80);
          expect((yield* Fiber.join(fiber)).state).toBe("escalated");
          expect(
            test.calls.filter((call) => call === "availability")
          ).toHaveLength(2);
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect("a failed NotifyOwner is logged and never stops finishing", () =>
    Effect.gen(function* notifyFailure() {
      const test = yield* harness;
      test.controls.outcome = "unknown";
      test.controls.failNotify = true;
      yield* Effect.gen(function* run() {
        expect((yield* fire(test)).state).toBe("escalated");
        expect(test.pages).toHaveLength(1);
        const log = yield* RunLog;
        expect(
          (yield* log.lines).some(
            (line) =>
              Predicate.isTagged(line, "outcome") &&
              line.outcome.status === "failed"
          )
        ).toBe(true);
      }).pipe(Effect.provide(test.layer));
    })
  );

  it.effect(
    "refuses resume after any deploy attempt, including a claimed attempt without outcome",
    () =>
      Effect.gen(function* noResume() {
        const test = yield* harness;
        yield* Effect.gen(function* run() {
          yield* ready();
          const log = yield* RunLog;
          yield* log.append(
            runLines.intent({
              intent: {
                at: 0,
                id: "synthetic/attempt",
                kind: "Deploy",
                target: config.input.target,
              },
            })
          );

          const refusal = yield* runRelease(config, {
            ...options,
            admission: { ...options.admission, verdict: "hold" },
          }).pipe(Effect.flip);

          expect(refusal._tag).toBe("DeployAttempted");
          expect(refusal.harm.length).toBeGreaterThan(0);
          expect(refusal.next.length).toBeGreaterThan(0);
          expect(test.calls).not.toContain("deploy");
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect("dry-run and ready wiring cannot reach supplied live sinks", () =>
    Effect.gen(function* noLiveSinks() {
      const test = yield* harness;
      yield* Effect.gen(function* run() {
        yield* ready();

        const result = yield* runRelease(config, {
          ...options,
          mode: "dry-run",
        });

        expect(result.state).toBe("rehearsed");
        yield* MessageSink.use((sink) => sink.page("rehearsal page")).pipe(
          Effect.provide(printOnlyReleaseLayer)
        );
        yield* VerdictSink.use((verdict) =>
          verdict.write({
            evidence: "rehearsal",
            outcome: "pass",
            sha: "synthetic",
            step: "synthetic",
            ts: 0,
          })
        ).pipe(Effect.provide(printOnlyReleaseLayer));
        expect(test.pages).toEqual([]);
        expect(test.verdicts).toEqual([]);
        expect(test.messages).toEqual([]);
        expect(test.calls).not.toContain("deploy");
      }).pipe(Effect.provide(test.layer));
    })
  );

  it.effect("refusals carry harm and next for every admission boundary", () =>
    Effect.gen(function* refusalBoundaries() {
      const test = yield* harness;
      yield* Effect.gen(function* run() {
        const assertRefusal = Effect.fn("TestRelease.assertRefusal")(
          function* assertRefusal(
            expected: string,
            value: ReleaseConfig,
            runOptions: ReleaseRunOptions
          ) {
            const refusal = yield* runRelease(value, runOptions).pipe(
              Effect.flip
            );

            expect(refusal._tag).toBe(expected);
            expect(refusal.harm).not.toBe("");
            expect(refusal.next).not.toBe("");
          }
        );

        yield* assertRefusal("Configuration", { ...config, name: "" }, options);
        yield* assertRefusal("Admission", config, {
          ...options,
          admission: { ...options.admission, words: "" },
        });
        yield* assertRefusal("Admission", config, {
          ...options,
          admittedRepo: "other/repo",
        });
        yield* assertRefusal("Ready", config, options);
        yield* assertRefusal(
          "Predecessor",
          { ...config, predecessor: "held" },
          { ...options, action: "ready" }
        );
        test.controls.invalidPlan = true;
        yield* assertRefusal("Plan", config, { ...options, action: "ready" });
        test.controls.invalidPlan = false;
        test.controls.failPreflight = true;
        yield* assertRefusal("Preflight", config, {
          ...options,
          action: "ready",
        });
        test.controls.failPreflight = false;
        test.controls.planCrash = true;
        yield* assertRefusal("Execution", config, {
          ...options,
          action: "ready",
        });
        test.controls.planCrash = false;
        yield* ready();
        const store = yield* ReadyStore;
        const stored = yield* store.read;
        expect(stored).not.toBeNull();
        yield* store.write({
          planHash: "changed",
          rows,
          sha: config.input.target,
        });
        yield* assertRefusal("Ready", config, options);
        yield* assertRefusal(
          "Ready",
          { ...config, input: { ...config.input, target: "other-sha" } },
          options
        );
      }).pipe(Effect.provide(test.layer));
    })
  );

  for (const outcome of ["fail", "breach"]) {
    it.effect(`records a settled ${outcome} verdict before restoring`, () =>
      Effect.gen(function* settledFailure() {
        const test = yield* harness;
        test.controls.outcome = outcome;
        yield* Effect.gen(function* run() {
          expect((yield* fire(test)).state).toBe("restored");
          expect(test.verdicts).toHaveLength(1);
          expect(test.verdicts[0]?.outcome).toBe(outcome);
          expect(test.calls).toContain("restore");
        }).pipe(Effect.provide(test.layer));
      })
    );
  }

  it.effect(
    "a failed build escalates, notifies with the deployment, pages that production is unchanged and restores nothing",
    () =>
      Effect.gen(function* buildFailed() {
        const test = yield* harness;
        test.controls.line = JSON.stringify({
          deploymentId: "deployment-failed",
          outcome: "build-failed",
          state: "ERROR",
          url: "build.sample.test",
        });
        yield* Effect.gen(function* run() {
          expect((yield* fire(test)).state).toBe("escalated");
          expect(test.calls).not.toContain("restore");
          expect(test.calls.filter((call) => call === "notify")).toHaveLength(
            1
          );
          expect(test.verdicts).toEqual([]);
          expect(test.pages).toHaveLength(1);

          for (const said of [test.pages[0], test.messages.at(-1)]) {
            expect(said).toContain("deployment-failed");
            expect(said).toContain("ERROR");
            expect(said).toContain("production is unchanged");
          }

          const log = yield* RunLog;
          expect(
            (yield* log.lines).some(
              (line) =>
                Predicate.isTagged(line, "intent") &&
                line.intent.kind === "NotifyOwner" &&
                line.intent.cause === "observationBuildFailed"
            )
          ).toBe(true);
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect(
    "a superseding deployment ends the release as superseded, naming the newer commit, with no restore, notification or page",
    () =>
      Effect.gen(function* superseded() {
        const test = yield* harness;
        test.controls.line = JSON.stringify({
          by: "0123456789abcdef0123456789abcdef01234567",
          deploymentId: "deployment-newer",
          outcome: "superseded",
        });
        yield* Effect.gen(function* run() {
          expect((yield* fire(test)).state).toBe("superseded");
          expect(test.calls).not.toContain("restore");
          expect(test.calls).not.toContain("notify");
          expect(test.pages).toEqual([]);
          expect(test.verdicts).toEqual([]);
          const finished = test.messages.at(-1);

          expect(finished).toMatch(/^finished: superseded\. /u);

          for (const said of [
            "01234567",
            "deployment-newer",
            "nothing to restore",
          ]) {
            expect(finished).toContain(said);
          }
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect(
    "each check stops at its own deadline while the release deadline remains bounded",
    () =>
      Effect.gen(function* checkDeadlines() {
        const test = yield* harness;
        test.controls.outcome = "unknown";

        const value: ReleaseConfig = {
          ...config,
          input: {
            ...config.input,
            checks: [
              {
                everyMs: 10,
                name: "availability",
                onFail: "restore",
                timeoutMs: 25,
              },
              {
                everyMs: 30,
                name: "integrity",
                onFail: "escalate",
                timeoutMs: 80,
              },
            ],
          },
        };

        yield* Effect.gen(function* run() {
          yield* ready(value);

          const fiber = yield* runRelease(value, options).pipe(
            Effect.forkScoped
          );

          yield* Queue.take(test.observed).pipe(
            Effect.repeat({ until: (line) => line.endsWith(": observing") })
          );
          yield* TestClock.adjust(50);
          expect(
            test.calls.filter((call) => call === "availability")
          ).toHaveLength(3);
          yield* TestClock.adjust(50);
          expect((yield* Fiber.join(fiber)).state).toBe("escalated");
          expect(
            test.calls.filter((call) => call === "availability")
          ).toHaveLength(3);
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect(
    "records the operator's override words and every review state change",
    () =>
      Effect.gen(function* overrideAdmission() {
        const test = yield* harness;

        const value: ReleaseConfig = {
          ...config,
          input: { ...config.input, overrideBy: "operator" },
        };

        const admission = {
          by: "operator",
          override: true,
          verdict: "hold",
          words: "I accept this held review for this release.",
        } satisfies typeof options.admission;

        yield* Effect.gen(function* run() {
          expect(
            (yield* fire(test, value, { ...options, admission })).state
          ).toBe("accepted");
          const log = yield* RunLog;
          expect(
            (yield* log.lines).some(
              (line) =>
                Predicate.isTagged(line, "event") &&
                Predicate.isTagged(line.event, "override") &&
                line.event.reason === admission.words
            )
          ).toBe(true);
          expect(
            test.messages.filter((message) => message.endsWith(": armed"))
          ).toHaveLength(1);
          expect(
            test.messages.filter((message) => message.endsWith(": reviewHeld"))
          ).toHaveLength(1);
          expect(
            test.messages.filter((message) => message.endsWith(": fired"))
          ).toHaveLength(1);
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect(
    "config and admission refusals name every path without exposing wrong values",
    () =>
      Effect.gen(function* refusalPaths() {
        const test = yield* harness;
        const secret = "sk_test_SYNTHETIC_VALUE_MUST_NOT_APPEAR";

        const invalidConfig: ReleaseConfig = {
          ...config,
          input: {
            ...config.input,
            checks: [
              { ...config.input.checks[0] },
              ...config.input.checks.slice(1).map((check) => ({ ...check })),
            ],
          },
          preflight: { ...config.preflight },
        };

        Object.defineProperty(invalidConfig.input.checks[0], "everyMs", {
          value: secret,
        });
        Object.defineProperty(invalidConfig.preflight, "args", {
          value: secret,
        });
        const admission = { ...options.admission };
        Object.defineProperty(admission, "verdict", { value: secret });
        Object.defineProperty(admission, "override", { value: secret });
        yield* Effect.gen(function* decodeBoundaries() {
          const configCause = yield* Schema.decodeEffect(ReleaseConfigSchema, {
            errors: "all",
            reportInput: true,
          })(invalidConfig).pipe(Effect.flip);

          const admissionCause = yield* Schema.decodeEffect(AdmissionSchema, {
            errors: "all",
            reportInput: true,
          })(admission).pipe(Effect.flip);

          expect(
            JSON.stringify(releaseAdmissionRefusal(admissionCause))
          ).not.toContain(secret);

          for (const refusal of [
            releaseConfigRefusal(configCause),
            yield* decodeReleaseConfig(JSON.stringify(invalidConfig)).pipe(
              Effect.flip
            ),
            yield* runRelease(invalidConfig, options).pipe(Effect.flip),
          ]) {
            expect(JSON.stringify(refusal)).not.toContain(secret);
            expect(refusal._tag).toBe("Configuration");

            for (const path of ["input.checks.0.everyMs", "preflight.args"]) {
              expect(refusal.harm).toContain(path);
              expect(refusal.next).toContain(path);
            }
          }

          const refusal = yield* runRelease(config, {
            ...options,
            admission,
          }).pipe(Effect.flip);

          expect(JSON.stringify(refusal)).not.toContain(secret);
          expect(refusal._tag).toBe("Admission");

          for (const path of ["override", "verdict"]) {
            expect(refusal.harm).toContain(path);
            expect(refusal.next).toContain(path);
          }

          const malformed = yield* decodeReleaseConfig(
            `not JSON ${secret}`
          ).pipe(Effect.flip);

          expect(JSON.stringify(malformed)).not.toContain(secret);
          expect(malformed.harm).toContain("configuration root");
          expect(test.calls).toEqual([]);
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect(
    "the reachable release graph exposes all final outcomes without lifecycle fields in context",
    () =>
      Effect.gen(function* finalGraph() {
        const reviewConfig: ReleaseConfig = {
          ...config,
          input: { ...config.input, overrideBy: "operator" },
        };

        const heldOptions: ReleaseRunOptions = {
          ...options,
          admission: { ...options.admission, verdict: "hold" },
        };

        const scenarios: readonly {
          readonly config: ReleaseConfig;
          readonly final: string;
          readonly options: ReleaseRunOptions;
          readonly line?: string;
          readonly outcome: "pass" | "fail" | "unknown";
        }[] = [
          {
            config,
            final: "ready",
            options: { ...options, action: "ready" },
            outcome: "pass",
          },
          {
            config,
            final: "rehearsed",
            options: { ...options, mode: "dry-run" },
            outcome: "pass",
          },
          { config, final: "accepted", options, outcome: "pass" },
          { config, final: "restored", options, outcome: "fail" },
          { config, final: "escalated", options, outcome: "unknown" },
          {
            config,
            final: "superseded",
            line: JSON.stringify({
              by: "commit-newer",
              deploymentId: "deployment-newer",
              outcome: "superseded",
            }),
            options,
            outcome: "pass",
          },
          { config, final: "held", options: heldOptions, outcome: "pass" },
          {
            config: reviewConfig,
            final: "reviewHeld",
            options: heldOptions,
            outcome: "pass",
          },
          {
            config: reviewConfig,
            final: "accepted",
            options: {
              ...heldOptions,
              admission: { ...heldOptions.admission, override: true },
            },
            outcome: "pass",
          },
          {
            config: {
              ...config,
              input: { ...config.input, blackoutUntil: 100_000 },
            },
            final: "armed",
            options,
            outcome: "pass",
          },
          {
            config,
            final: "refused",
            options: { ...options, admittedRepo: "other/repo" },
            outcome: "pass",
          },
        ];

        const finals: string[] = [];
        const states: string[] = [];

        for (const scenario of scenarios) {
          const test = yield* harness;
          test.controls.outcome = scenario.outcome;
          test.controls.line = scenario.line ?? "";
          yield* Effect.gen(function* trace() {
            yield* ready(scenario.config);

            const actor = yield* createEffectActor(releaseDriverMachine, {
              input: { config: scenario.config, options: scenario.options },
            });

            expect(Object.keys(actor.getSnapshot().context).toSorted()).toEqual(
              ["config", "error", "executed", "options", "persisted", "ready"]
            );
            states.push(actor.getSnapshot().value);

            const subscription = actor.subscribe((snapshot) => {
              states.push(snapshot.value);
            });

            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                subscription.unsubscribe();
              })
            );
            yield* waitFor(
              actor,
              (snapshot) =>
                snapshot.matches("observing") || snapshot.status === "done"
            ).pipe(Effect.orDie);
            yield* TestClock.adjust(100);

            const final = yield* waitFor(
              actor,
              (snapshot) => snapshot.status === "done"
            ).pipe(Effect.orDie);

            expect(final.status).toBe("done");
            expect(final.value).toBe(scenario.final);
            expect(test.pages).toHaveLength(
              scenario.final === "held" || scenario.final === "escalated"
                ? 1
                : 0
            );
            finals.push(final.value);
          }).pipe(
            Effect.provideService(
              ReleaseCommandConfig,
              scenario.config.commands
            ),
            Effect.provide(test.layer)
          );
        }

        expect([...new Set(finals)].toSorted()).toEqual([
          "accepted",
          "armed",
          "escalated",
          "held",
          "ready",
          "refused",
          "rehearsed",
          "restored",
          "reviewHeld",
          "superseded",
        ]);
        expect([...new Set(states)].toSorted()).toEqual([
          "accepted",
          "admitting",
          "armed",
          "baselining",
          "completing",
          "deploying",
          "escalated",
          "firing",
          "held",
          "notifying",
          "observing",
          "overriding",
          "paging",
          "planning",
          "preparing",
          "ready",
          "refused",
          "rehearsed",
          "restored",
          "restoring",
          "reviewHeld",
          "reviewing",
          "superseded",
        ]);
      })
  );

  it.effect(
    "reaches the declared driver states through real actor execution",
    () =>
      Effect.gen(function* reachable() {
        const test = yield* harness;
        yield* Effect.gen(function* run() {
          yield* ready();
          const gate = yield* Deferred.make<boolean>();
          const subscribed = yield* Deferred.make<boolean>();
          const store = yield* ReadyStore;

          const actor = yield* createEffectActor(releaseDriverMachine, {
            input: { config, options },
          }).pipe(
            Effect.provideService(ReadyStore, {
              read: Deferred.await(gate).pipe(Effect.andThen(store.read)),
              write: store.write,
            })
          );

          const history = yield* snapshots(actor).pipe(
            Stream.takeUntil((snapshot) => snapshot.status === "done"),
            Stream.tap((snapshot) =>
              snapshot.matches("admitting")
                ? Deferred.succeed(subscribed, true).pipe(Effect.asVoid)
                : Effect.void
            ),
            Stream.map((snapshot) => snapshot.value),
            Stream.runCollect,
            Effect.forkScoped
          );

          yield* Deferred.await(subscribed);
          yield* Deferred.succeed(gate, true);
          yield* Queue.take(test.observed).pipe(
            Effect.repeat({ until: (line) => line.endsWith(": observing") })
          );
          yield* TestClock.adjust(100);
          const reached = yield* Fiber.join(history);
          expect(
            reached.filter((value, index) => reached.indexOf(value) === index)
          ).toEqual([
            "admitting",
            "planning",
            "reviewing",
            "firing",
            "baselining",
            "deploying",
            "observing",
            "completing",
            "accepted",
          ]);
          expect(Object.keys(releaseCheckMachine.states).toSorted()).toEqual([
            "expired",
            "sampling",
            "settled",
            "waiting",
          ]);
        }).pipe(
          Effect.provideService(ReleaseCommandConfig, config.commands),
          Effect.provide(test.layer)
        );
      })
  );

  it.effect(
    "rejects a plan changed between admission and execution before Deploy",
    () =>
      Effect.gen(function* drift() {
        const test = yield* harness;
        test.controls.drift = true;
        yield* Effect.gen(function* run() {
          yield* ready();

          const refusal = yield* runRelease(config, {
            ...options,
            admission: { ...options.admission, verdict: "hold" },
          }).pipe(Effect.flip);

          expect(refusal._tag).toBe("Execution");
          expect(refusal.harm).toContain("Plan changed");
          expect(refusal.next).not.toBe("");
          expect(test.calls).not.toContain("deploy");
        }).pipe(Effect.provide(test.layer));
      })
  );

  it.effect("refuses unreadable storage with harm and next", () =>
    Effect.gen(function* storage() {
      const test = yield* harness;

      const broken = Layer.succeed(ReadyStore, {
        read: Effect.fail(
          new ExecutorError({
            code: "storage",
            message: "synthetic storage failure",
          })
        ),
        write: () => Effect.void,
      });

      const refusal = yield* runRelease(config, options).pipe(
        Effect.provide(Layer.mergeAll(test.layer, broken)),
        Effect.flip
      );

      expect(refusal._tag).toBe("Storage");
      expect(refusal.harm).not.toBe("");
      expect(refusal.next).not.toBe("");
    })
  );

  it.effect("stops a non-notification intent that fails without events", () =>
    Effect.gen(function* noEvents() {
      const test = yield* harness;
      yield* Effect.gen(function* run() {
        yield* ready();

        const mismatch = ConfigProvider.layer(
          ConfigProvider.fromUnknown({ PIPER_LIVE_ADMITTED_REPO: "other/repo" })
        );

        const refusal = yield* runRelease(config, options).pipe(
          Effect.provide(mismatch),
          Effect.flip
        );

        expect(refusal._tag).toBe("Execution");
        expect(refusal.harm).toContain("requires PIPER_LIVE_ADMITTED_REPO");
        expect(test.calls).not.toContain("deploy");
        expect(test.messages.at(-1)).toBe("finished: planned");
      }).pipe(Effect.provide(test.layer));
    })
  );

  it.effect(
    "keeps observer storage failures typed instead of hiding them until the deadline",
    () =>
      Effect.gen(function* observerFailure() {
        const test = yield* harness;

        const broken = Layer.succeed(VerdictSink, {
          write: () =>
            Effect.fail(
              new ExecutorError({
                code: "storage",
                message: "synthetic verdict storage failure",
              })
            ),
        });

        const refusal = yield* fire(test).pipe(
          Effect.provide(Layer.mergeAll(test.layer, broken)),
          Effect.flip
        );

        expect(refusal._tag).toBe("Execution");
        expect(refusal.harm).toBe("synthetic verdict storage failure");
        expect(refusal.next).not.toBe("");
      })
  );

  it.effect("constructs no live sinks for dry fire or manual ready", () =>
    Effect.gen(function* construction() {
      const built: string[] = [];

      const live = () => {
        built.push("live");

        return printOnlyReleaseLayer;
      };

      for (const layer of [
        releaseSinkLayer("fire", "dry-run", live),
        releaseSinkLayer("ready", "live", live),
      ]) {
        yield* MessageSink.use((sink) => sink.page("print only")).pipe(
          Effect.provide(layer)
        );
      }

      expect(built).toEqual([]);
    })
  );

  it.effect(
    "live messages log what was said, when, and whether it woke the operator",
    () =>
      Effect.gen(function* messageReceipts() {
        const fs = yield* FileSystem.FileSystem;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "piper-message-test-",
        });

        const store = yield* releaseMemoryStore;
        const sent: string[] = [];
        const control = { fail: false };

        const commands = Layer.succeed(ReleaseCommands, {
          run: Effect.fn("TestMessage.run")(function* run(
            command: typeof ReleaseCommandSchema.Type
          ) {
            if (control.fail) {
              return yield* new ExecutorError({
                code: "provider",
                message: "synthetic message failure",
              });
            }

            sent.push(command.args.at(-1) ?? "");

            return "sent";
          }),
        });

        const layer = liveFireSinks(config, `${directory}/verdicts.tsv`).pipe(
          Layer.provide(Layer.mergeAll(store, commands))
        );

        yield* Effect.gen(function* sendMessages() {
          const sink = yield* MessageSink;
          yield* sink.send("state message");
          yield* sink.page("held page");
          yield* TestClock.adjust(7);
          control.fail = true;
          const failure = yield* sink.page("failed page").pipe(Effect.flip);
          expect(failure.code).toBe("provider");
        }).pipe(Effect.provide(layer));

        const lines = yield* RunLog.use((log) => log.lines).pipe(
          Effect.provide(store)
        );

        expect(sent).toEqual(["state message", "held page"]);
        expect(
          lines.filter((line) => Predicate.isTagged(line, "said"))
        ).toEqual([
          runLines.said({ at: 0, said: "state message", wake: false }),
          runLines.said({ at: 0, said: "held page", wake: true }),
        ]);
        expect(
          lines.find((line) => Predicate.isTagged(line, "message-failed"))
        ).toMatchObject({
          at: 7,
          error: { code: "provider", message: "synthetic message failure" },
          said: "failed page",
          wake: true,
        });
      }).pipe(Effect.provide(NodeFileSystem.layer))
  );

  it.effect(
    "memory and file verdict layers dedupe settled rows across reopen",
    () =>
      Effect.gen(function* verdictLayers() {
        const fs = yield* FileSystem.FileSystem;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "piper-release-test-",
        });

        const row: VerdictRow = {
          evidence: "synthetic evidence",
          outcome: "pass",
          sha: "synthetic-sha",
          step: "synthetic-check",
          ts: 0,
        };

        const memory = yield* makeVerdictMemory;
        const logStore = yield* releaseMemoryStore;

        const twice = VerdictSink.use((sink) =>
          sink.write(row).pipe(Effect.andThen(sink.write(row)))
        );

        yield* twice.pipe(Effect.provide(memory.layer));
        expect(yield* memory.rows).toEqual([row]);
        const path = `${directory}/verdicts.tsv`;

        const commandLayer = Layer.succeed(ReleaseCommands, {
          run: () => Effect.die("Verdict test reached a message command"),
        });

        for (const attempt of [1, 2]) {
          expect(attempt).toBeGreaterThan(0);
          yield* twice.pipe(
            Effect.provide(
              liveFireSinks(config, path).pipe(
                Layer.provide(Layer.mergeAll(commandLayer, logStore))
              )
            ),
            Effect.scoped
          );
        }

        expect(yield* fs.readFileString(path)).toBe(
          "0\tsynthetic-sha\tsynthetic-check\tpass\tsynthetic: synthetic evidence\n"
        );
        const state = `${directory}/state`;
        yield* RunLog.use((log) =>
          log.append(
            runLines.intent({
              intent: {
                at: 0,
                id: "synthetic/1",
                kind: "Deploy",
                target: config.input.target,
              },
            })
          )
        ).pipe(Effect.provide(releaseFileStore(state)), Effect.scoped);

        const lines = yield* RunLog.use((log) => log.lines).pipe(
          Effect.provide(releaseFileStore(state)),
          Effect.scoped
        );

        expect(lines).toHaveLength(1);
      }).pipe(Effect.provide(NodeFileSystem.layer))
  );
});
