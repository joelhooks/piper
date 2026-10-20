import { releaseMachine } from "@joelhooks/piper/release";
import {
  ReleasePlanSchema,
  toReleaseEvent,
} from "@joelhooks/piper/release-domain";
import type { PostedReleaseEvent } from "@joelhooks/piper/release-domain";
import {
  openRelease,
  readRelease,
  stepRelease,
} from "@joelhooks/piper/release-host";
import type { PersistedRelease } from "@joelhooks/piper/release-host";
import {
  createEffectActor,
  createEffectLogic,
  send,
  setupEffect,
  waitFor,
} from "@xstate/effect";
import {
  Clock,
  Crypto,
  Data,
  Deferred,
  Effect,
  Layer,
  Predicate,
  Schema,
  Semaphore,
} from "effect";
import { types } from "xstate";

import { ExecutorError } from "./domain.js";
import type { Job } from "./domain.js";
import { Recorder } from "./recorder.js";
import { CheckDelivery } from "./release-check.js";
import type { CheckInput } from "./release-check.js";
import { runObservers } from "./release-observers.js";
import { AdmissionSchema, ReleaseConfigSchema } from "./release-run-domain.js";
import type {
  Admission,
  Ready,
  ReleaseConfig,
  ReleaseRefusal,
} from "./release-run-domain.js";
import { runLines } from "./release-run-log.js";
import { attemptedDeploy, codeOnlyPlan } from "./release-run-policy.js";
import {
  MessageSink,
  printOnlyReleaseLayer,
  ReadyStore,
  RunLog,
  VerdictSink,
} from "./release-run-services.js";
import {
  commandLastLine,
  executeRelease,
  ReleaseCommandConfig,
  ReleaseCommands,
} from "./release.js";

const refusals = Data.taggedEnum<ReleaseRefusal>();

const events = Data.taggedEnum<PostedReleaseEvent>();

const jobs = Data.taggedEnum<Job>();

export interface ReleaseRunOptions {
  readonly action: "ready" | "fire";
  readonly admission: Admission;
  readonly admittedRepo: string;
  readonly mode: "dry-run" | "live";
}

interface DriverInput {
  readonly config: ReleaseConfig;
  readonly options: ReleaseRunOptions;
}

interface DriverContext extends DriverInput {
  readonly error: ReleaseRefusal | null;
  readonly executed: readonly string[];
  readonly persisted: PersistedRelease | null;
  readonly ready: Ready | null;
  readonly route: "driving" | "observing" | "finishing";
  readonly state: string;
}

export const releasePlanHash = Effect.fn("ReleaseRun.planHash")(
  function* releasePlanHash(rows: typeof ReleasePlanSchema.Type) {
    const crypto = yield* Crypto.Crypto;

    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows)))
      .pipe(
        Effect.mapError(() =>
          refusals.Configuration({
            harm: "The plan hash could not be computed.",
            next: "Restore the crypto service and prepare again.",
          })
        )
      );

    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    );
  }
);

const executionRefusal = (
  error: ExecutorError | ReleaseRefusal
): ReleaseRefusal =>
  Predicate.isTagged(error, "ExecutorError")
    ? refusals.Execution({
        harm: error.message,
        next: "Inspect the run log and reconcile external effects before starting a new release.",
      })
    : error;

const storageRefusal = (): ReleaseRefusal =>
  refusals.Storage({
    harm: "Release records cannot be read or written safely.",
    next: "Preserve the state directory, reconcile the writer and repair storage before retrying.",
  });

const prepare = Effect.fn("ReleaseRun.prepare")(function* prepare(
  config: ReleaseConfig
) {
  if (config.predecessor !== "accepted") {
    return yield* Effect.fail(
      refusals.Predecessor({
        harm: "The predecessor is not accepted; this release could compound an unresolved failure.",
        next: "Accept the predecessor before preparing this release.",
      })
    );
  }

  const runner = yield* ReleaseCommands;
  const command = config.commands.PlanRelease;

  if (command === undefined) {
    return yield* Effect.fail(
      refusals.Configuration({
        harm: "The plan command is missing.",
        next: "Configure PlanRelease and prepare again.",
      })
    );
  }

  const output = yield* runner
    .run({
      args: [...command.args, "--target", config.input.target],
      command: command.command,
    })
    .pipe(Effect.mapError(executionRefusal));

  const rows = yield* Schema.decodeEffect(
    Schema.fromJsonString(ReleasePlanSchema)
  )(commandLastLine(output)).pipe(
    Effect.mapError(() =>
      refusals.Plan({
        harm: "The plan is unreadable.",
        next: "Repair the plan command's JSON output and prepare again.",
      })
    )
  );

  if (!codeOnlyPlan(rows, config.input.expectation)) {
    return yield* Effect.fail(
      refusals.Plan({
        harm: "The plan contains changes outside the code-only boundary.",
        next: "Remove non-code changes or obtain a separately reviewed release plan.",
      })
    );
  }

  yield* runner.run(config.preflight).pipe(
    Effect.mapError(() =>
      refusals.Preflight({
        harm: "Preflight did not return OK.",
        next: "Fix the preflight failure and prepare again.",
      })
    )
  );

  return {
    planHash: yield* releasePlanHash(rows),
    rows,
    sha: config.input.target,
  } satisfies Ready;
});

const announce = Effect.fn("ReleaseRun.announce")(function* announce(
  config: ReleaseConfig,
  before: string,
  after: string
) {
  if (before !== after) {
    const log = yield* RunLog;
    const sink = yield* MessageSink;
    yield* log.append(runLines.state({ state: after }));
    yield* sink
      .send(
        `release ${config.name} ${config.input.target.slice(0, 8)}: ${after}`
      )
      .pipe(Effect.catch(() => Effect.void));
  }
});

const admit = Effect.fn("ReleaseRun.admit")(function* admit(
  input: DriverInput
) {
  const store = yield* ReadyStore;
  const log = yield* RunLog;

  if (input.options.action === "ready") {
    const ready = yield* prepare(input.config);
    yield* store.write(ready).pipe(Effect.mapError(storageRefusal));

    return { persisted: null, ready };
  }

  if (input.options.admittedRepo !== input.config.repo) {
    return yield* Effect.fail(
      refusals.Admission({
        harm: "The admitted repository does not match; fire could deploy an unintended repository.",
        next: "Set the admitted repository to this exact configured repository after operator review.",
      })
    );
  }

  const previous = yield* log.lines.pipe(Effect.mapError(storageRefusal));

  if (attemptedDeploy(previous, input.config.input.target)) {
    return yield* Effect.fail(
      refusals.DeployAttempted({
        harm: "Deploy was already attempted; replay could duplicate or overwrite a partial release.",
        next: "Reconcile the attempted deployment manually and create a new release; never resume this one.",
      })
    );
  }

  const stored = yield* store.read.pipe(Effect.mapError(storageRefusal));

  if (stored === null || stored.sha !== input.config.input.target) {
    return yield* Effect.fail(
      refusals.Ready({
        harm: "READY is missing or names a different commit.",
        next: "Run release ready for this exact commit and plan before fire.",
      })
    );
  }

  const ready = yield* prepare(input.config);

  if (ready.planHash !== stored.planHash) {
    return yield* Effect.fail(
      refusals.Ready({
        harm: "The current plan differs from READY.",
        next: "Review the changed plan and run release ready again.",
      })
    );
  }

  const at = yield* Clock.currentTimeMillis;
  const persisted = yield* openRelease({ ...input.config.input, at });
  yield* announce(input.config, "", "planned").pipe(
    Effect.mapError(storageRefusal)
  );
  yield* log
    .append(runLines.admission({ admission: input.options.admission }))
    .pipe(Effect.mapError(storageRefusal));

  return { persisted, ready };
});

const step = Effect.fn("ReleaseRun.step")(function* step(
  config: ReleaseConfig,
  persisted: PersistedRelease,
  posted: readonly PostedReleaseEvent[]
) {
  const log = yield* RunLog;

  return yield* Effect.reduce(
    posted,
    () => persisted,
    (current, event) =>
      Effect.gen(function* stepEvent() {
        const before = yield* readRelease(current);

        if (before.status !== "active") {
          return current;
        }

        yield* log.append(runLines.event({ event }));

        const next = yield* stepRelease(current, [toReleaseEvent(event)]).pipe(
          Effect.orDie
        );

        const after = yield* readRelease(next);
        yield* announce(config, before.value, after.value);

        return next;
      })
  );
});

const drive = Effect.fn("ReleaseRun.drive")(function* drive(
  context: DriverContext
) {
  if (context.persisted === null) {
    return context;
  }

  const snapshot = yield* readRelease(context.persisted);
  const state = snapshot.value;
  yield* announce(context.config, context.state, state);

  const intent = snapshot.context.intents.find(
    (candidate) => !context.executed.includes(candidate.id)
  );

  if (intent === undefined) {
    return { ...context, route: "finishing", state } satisfies DriverContext;
  }

  if (intent.kind === "Observe") {
    return { ...context, route: "observing", state } satisfies DriverContext;
  }

  const log = yield* RunLog;
  yield* log.append(runLines.intent({ intent }));
  const executed = [...context.executed, intent.id];

  if (intent.kind === "RequestReview") {
    const { by, override, verdict, words } = context.options.admission;
    const at = yield* Clock.currentTimeMillis;
    const reviewed = events.reviewed({ at, by, verdict });

    const admissionEvents =
      verdict === "hold" && override
        ? [reviewed, events.override({ at, by, reason: words })]
        : [reviewed];

    const reviewedState = yield* step(
      context.config,
      context.persisted,
      admissionEvents
    );

    const admitted = yield* readRelease(reviewedState);

    const persisted = admitted.matches("armed")
      ? yield* step(context.config, reviewedState, [
          events.fire({ at: yield* Clock.currentTimeMillis, by }),
        ])
      : reviewedState;

    return {
      ...context,
      executed,
      persisted,
      state: (yield* readRelease(persisted)).value,
    };
  }

  const outcome = yield* executeRelease(
    jobs.release({
      head: context.config.input.target,
      intent,
      repo: context.config.repo,
      target: context.config.input.runId,
    }),
    { baseBranch: "main", baselineWorkflows: {}, mode: context.options.mode }
  );

  yield* log.append(runLines.outcome({ id: intent.id, outcome }));

  if (
    outcome.status === "failed" &&
    outcome.events.length === 0 &&
    intent.kind !== "NotifyOwner"
  ) {
    return yield* new ExecutorError({
      code: "provider",
      message: outcome.error?.message ?? "Release intent failed without events",
    });
  }

  const planned = outcome.events.find((event) =>
    Predicate.isTagged(event, "planned")
  );

  if (
    planned !== undefined &&
    Predicate.isTagged(planned, "planned") &&
    (yield* releasePlanHash(planned.rows)) !== context.ready?.planHash
  ) {
    return yield* new ExecutorError({
      code: "configuration",
      message:
        "Plan changed after READY admission; prepare the changed plan before fire",
    });
  }

  const persisted = yield* step(
    context.config,
    context.persisted,
    outcome.events
  );

  return {
    ...context,
    executed,
    persisted,
    route: outcome.status === "recorded-would-do" ? "finishing" : "driving",
    state: (yield* readRelease(persisted)).value,
  } satisfies DriverContext;
});

const observe = Effect.fn("ReleaseRun.observe")(function* observe(
  context: DriverContext
) {
  if (context.persisted === null) {
    return context;
  }

  const original = yield* readRelease(context.persisted);

  const intent = original.context.intents.findLast(
    (candidate) => candidate.kind === "Observe"
  );

  if (intent?.kind !== "Observe") {
    return context;
  }

  const log = yield* RunLog;
  const verdicts = yield* VerdictSink;

  const actor = yield* createEffectActor(releaseMachine, {
    snapshot: context.persisted,
  });

  const mutex = yield* Semaphore.make(1);
  const environment = yield* Effect.context<MessageSink | RunLog>();

  const deliver = Effect.fn("ReleaseRun.observation")(
    function* deliver(posted: readonly PostedReleaseEvent[]) {
      const before = actor.getSnapshot();

      if (before.status !== "active") {
        return;
      }

      for (const event of posted) {
        yield* log.append(runLines.event({ event }));

        if (
          Predicate.isTagged(event, "observed") &&
          event.outcome !== "unknown"
        ) {
          yield* verdicts.write({
            evidence: JSON.stringify(event.detail ?? {}),
            outcome: event.outcome,
            sha: context.config.input.target,
            step: event.check,
            ts: event.at,
          });
        }

        yield* send(actor, toReleaseEvent(event));
      }

      const token = before.context.sync + 1;
      yield* send(actor, { token, type: "sync" });

      const after = yield* waitFor(
        actor,
        (snapshot) =>
          snapshot.status !== "active" || snapshot.context.sync >= token
      ).pipe(Effect.orDie);

      yield* announce(context.config, before.value, after.value);
    },
    (effect) => mutex.withPermit(effect)
  );

  const inputs = context.config.input.checks
    .filter((check) => original.context.observations[check.name] !== "pass")
    .map((check): CheckInput => ({
      config: context.config,
      deadlineAt: Math.min(intent.deadlineAt, intent.at + check.timeoutMs),
      everyMs: check.everyMs,
      intent: { ...intent, checks: [check] },
    }));

  const failed = yield* Deferred.make<never, ExecutorError>();

  const delivery = CheckDelivery.of({
    deliver: (outcome) =>
      log
        .append(runLines.outcome({ id: intent.id, outcome }))
        .pipe(
          Effect.andThen(
            deliver(outcome.events).pipe(Effect.provideContext(environment))
          )
        ),
    signalFailure: (error) => Deferred.fail(failed, error).pipe(Effect.asVoid),
  });

  const now = yield* Clock.currentTimeMillis;

  const deadline = Effect.sleep(Math.max(0, intent.deadlineAt - now)).pipe(
    Effect.andThen(
      Effect.gen(function* expire() {
        yield* deliver([events.tick({ at: yield* Clock.currentTimeMillis })]);

        return yield* Effect.never;
      })
    )
  );

  yield* Effect.raceAllFirst([
    Deferred.await(failed),
    runObservers(inputs).pipe(Effect.provideService(CheckDelivery, delivery)),
    deadline,
    waitFor(actor, (snapshot) => !snapshot.matches("observing")).pipe(
      Effect.orDie
    ),
  ]);

  return {
    ...context,
    executed: [...context.executed, intent.id],
    persisted: actor.getPersistedSnapshot(),
    route: "driving",
    state: actor.getSnapshot().value,
  } satisfies DriverContext;
}, Effect.scoped);

const finish = Effect.fn("ReleaseRun.finish")(function* finish(
  context: DriverContext
) {
  const sink = yield* MessageSink;
  const log = yield* RunLog;
  yield* log.append(runLines.finished({ state: context.state }));
  yield* sink
    .send(`finished: ${context.state}`)
    .pipe(Effect.catch(() => Effect.void));

  if (context.state === "held" || context.state === "escalated") {
    yield* sink
      .page(
        `release ${context.config.name} ${context.config.input.target.slice(0, 8)}: ${context.state}`
      )
      .pipe(Effect.catch(() => Effect.void));
  }
});

const admissionTask = createEffectLogic({
  effect: ({ input }) => admit(input).pipe(Effect.result),
  schemas: { input: types<DriverInput>() },
});

const driveTask = createEffectLogic({
  effect: ({ input }) =>
    drive(input).pipe(Effect.mapError(executionRefusal), Effect.result),
  schemas: { input: types<DriverContext>() },
});

const observeTask = createEffectLogic({
  effect: ({ input }) =>
    observe(input).pipe(Effect.mapError(executionRefusal), Effect.result),
  schemas: { input: types<DriverContext>() },
});

const finishTask = createEffectLogic({
  effect: ({ input }) =>
    finish(input).pipe(Effect.mapError(executionRefusal), Effect.result),
  schemas: { input: types<DriverContext>() },
});

export const releaseDriverMachine = setupEffect({
  actors: { admissionTask, driveTask, finishTask, observeTask },
  schemas: { context: types<DriverContext>(), input: types<DriverInput>() },
}).createMachine({
  context: ({ input }) => ({
    ...input,
    error: null,
    executed: [],
    persisted: null,
    ready: null,
    route: "driving",
    state: "planned",
  }),
  initial: "admitting",
  states: {
    admitting: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "finished",
              }
            : {
                context: { ...context, ...event.output.success },
                target:
                  context.options.action === "ready" ? "finished" : "driving",
              },
        src: "admissionTask",
      },
    },
    driving: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "finishing",
              }
            : {
                context: event.output.success,
                reenter: true,
                target: event.output.success.route,
              },
        src: "driveTask",
      },
    },
    finished: { type: "final" },
    finishing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) => ({
          context: Predicate.isTagged(event.output, "Failure")
            ? { ...context, error: event.output.failure }
            : context,
          target: "finished",
        }),
        src: "finishTask",
      },
    },
    observing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "finishing",
              }
            : { context: event.output.success, target: "driving" },
        src: "observeTask",
      },
    },
  },
});

const recorderLayer = Layer.effect(
  Recorder,
  Effect.gen(function* makeReleaseRecorder() {
    const log = yield* RunLog;

    return Recorder.of({
      append: (record) => log.append(runLines["would-do"]({ record })),
    });
  })
);

const runDriver = Effect.fn("ReleaseRun.driver")(function* runDriver(
  input: DriverInput
) {
  const actor = yield* createEffectActor(releaseDriverMachine, { input });

  const snapshot = yield* waitFor(
    actor,
    (state) => state.status === "done"
  ).pipe(Effect.orDie);

  if (snapshot.context.error !== null) {
    return yield* Effect.fail(snapshot.context.error);
  }

  return { ready: snapshot.context.ready, state: snapshot.context.state };
}, Effect.scoped);

export const decodeReleaseConfig = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(ReleaseConfigSchema))(text).pipe(
    Effect.mapError(() =>
      refusals.Configuration({
        harm: "Release configuration is unreadable or invalid.",
        next: "Correct the JSON config against ReleaseConfigSchema before preparing or firing.",
      })
    )
  );

export const runRelease = Effect.fn("ReleaseRun.run")(function* runRelease(
  configValue: ReleaseConfig,
  options: ReleaseRunOptions
) {
  const config = yield* Schema.decodeEffect(ReleaseConfigSchema)(
    configValue
  ).pipe(
    Effect.mapError(() =>
      refusals.Configuration({
        harm: "Release configuration is invalid.",
        next: "Correct the config against ReleaseConfigSchema before preparing or firing.",
      })
    )
  );

  const admission = yield* Schema.decodeEffect(AdmissionSchema)(
    options.admission
  ).pipe(
    Effect.mapError(() =>
      refusals.Admission({
        harm: "Operator admission lacks a name or their words.",
        next: "Supply the operator's by and words with approve or hold and an explicit override decision.",
      })
    )
  );

  const program = runDriver({
    config,
    options: { ...options, admission },
  }).pipe(
    Effect.provideService(ReleaseCommandConfig, config.commands),
    Effect.provide(recorderLayer)
  );

  return yield* options.mode === "dry-run" || options.action === "ready"
    ? program.pipe(Effect.provide(printOnlyReleaseLayer))
    : program;
});
