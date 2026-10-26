import { releaseMachine } from "@joelhooks/piper/release";
import {
  ReleasePlanSchema,
  toReleaseEvent,
} from "@joelhooks/piper/release-domain";
import type {
  PostedReleaseEvent,
  ReleaseIntent,
} from "@joelhooks/piper/release-domain";
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
import {
  AdmissionSchema,
  ReleaseConfigSchema,
  VerdictRowSchema,
} from "./release-run-domain.js";
import type {
  Admission,
  Ready,
  ReleaseConfig,
  ReleaseRefusal,
} from "./release-run-domain.js";
import { runLines } from "./release-run-log.js";
import {
  attemptedDeploy,
  codeOnlyPlan,
  releaseAdmissionRefusal,
  releaseConfigRefusal,
  releaseNote,
} from "./release-run-policy.js";
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
import type { ReleaseOutcome } from "./release.js";

const refusals = Data.taggedEnum<ReleaseRefusal>();

const isVerdictOutcome = Schema.is(VerdictRowSchema.fields.outcome);

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
}

interface StageOutput {
  readonly context: DriverContext;
  readonly outcome: ReleaseOutcome | null;
  readonly snapshot: Effect.Success<ReturnType<typeof readRelease>>;
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

const prepareReady = Effect.fn("ReleaseRun.prepareReady")(
  function* prepareReady(config: ReleaseConfig) {
    const store = yield* ReadyStore;
    const ready = yield* prepare(config);
    yield* store.write(ready).pipe(Effect.mapError(storageRefusal));

    return ready;
  }
);

const admit = Effect.fn("ReleaseRun.admit")(function* admit(
  input: DriverInput
) {
  const store = yield* ReadyStore;
  const log = yield* RunLog;

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

const requirePersisted = Effect.fn("ReleaseRun.requirePersisted")(
  function* requirePersisted(context: DriverContext) {
    if (context.persisted === null) {
      return yield* Effect.die(
        new Error("A release stage requires an admitted release snapshot")
      );
    }

    return context.persisted;
  }
);

const stageOutput = Effect.fn("ReleaseRun.stageOutput")(function* stageOutput(
  context: DriverContext,
  outcome: ReleaseOutcome | null
): Effect.fn.Return<StageOutput> {
  const persisted = yield* requirePersisted(context);

  return { context, outcome, snapshot: yield* readRelease(persisted) };
});

const claim = Effect.fn("ReleaseRun.claim")(function* claim(
  context: DriverContext,
  kind: ReleaseIntent["kind"]
) {
  const persisted = yield* requirePersisted(context);
  const snapshot = yield* readRelease(persisted);

  const intent = snapshot.context.intents.find(
    (candidate) =>
      candidate.kind === kind && !context.executed.includes(candidate.id)
  );

  if (intent === undefined) {
    return yield* Effect.die(
      new Error("A release stage requires its unexecuted intent")
    );
  }

  const log = yield* RunLog;
  yield* log.append(runLines.intent({ intent }));

  return {
    context: { ...context, executed: [...context.executed, intent.id] },
    intent,
  };
});

const applyEvents = Effect.fn("ReleaseRun.applyEvents")(function* applyEvents(
  context: DriverContext,
  posted: readonly PostedReleaseEvent[],
  outcome: ReleaseOutcome | null
) {
  const current = yield* requirePersisted(context);
  const persisted = yield* step(context.config, current, posted);

  return yield* stageOutput({ ...context, persisted }, outcome);
});

const perform = Effect.fn("ReleaseRun.perform")(function* perform(
  context: DriverContext,
  kind: ReleaseIntent["kind"]
) {
  const claimed = yield* claim(context, kind);

  const outcome = yield* executeRelease(
    jobs.release({
      head: context.config.input.target,
      intent: claimed.intent,
      repo: context.config.repo,
      target: context.config.input.runId,
    }),
    { baseBranch: "main", baselineWorkflows: {}, mode: context.options.mode }
  );

  const log = yield* RunLog;
  yield* log.append(runLines.outcome({ id: claimed.intent.id, outcome }));

  if (
    outcome.status === "failed" &&
    outcome.events.length === 0 &&
    kind !== "NotifyOwner"
  ) {
    return yield* new ExecutorError({
      code: "provider",
      message: outcome.error?.message ?? "Release intent failed without events",
    });
  }

  return { context: claimed.context, outcome };
});

const executeStage = Effect.fn("ReleaseRun.executeStage")(
  function* executeStage(
    context: DriverContext,
    kind: "Baseline" | "Deploy" | "NotifyOwner" | "Restore"
  ) {
    const performed = yield* perform(context, kind);

    return yield* applyEvents(
      performed.context,
      performed.outcome.events,
      performed.outcome
    );
  }
);

const plan = Effect.fn("ReleaseRun.plan")(function* plan(
  context: DriverContext
) {
  const performed = yield* perform(context, "PlanRelease");

  const planned = performed.outcome.events.find((event) =>
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

  return yield* applyEvents(
    performed.context,
    performed.outcome.events,
    performed.outcome
  );
});

const review = Effect.fn("ReleaseRun.review")(function* review(
  context: DriverContext
) {
  const claimed = yield* claim(context, "RequestReview");
  const { by, verdict } = context.options.admission;

  return yield* applyEvents(
    claimed.context,
    [events.reviewed({ at: yield* Clock.currentTimeMillis, by, verdict })],
    null
  );
});

const override = Effect.fn("ReleaseRun.override")(function* override(
  context: DriverContext
) {
  const { by, words } = context.options.admission;

  return yield* applyEvents(
    context,
    [
      events.override({
        at: yield* Clock.currentTimeMillis,
        by,
        reason: words,
      }),
    ],
    null
  );
});

const fireRelease = Effect.fn("ReleaseRun.fire")(function* fireRelease(
  context: DriverContext
) {
  return yield* applyEvents(
    context,
    [
      events.fire({
        at: yield* Clock.currentTimeMillis,
        by: context.options.admission.by,
      }),
    ],
    null
  );
});

const observe = Effect.fn("ReleaseRun.observe")(function* observe(
  context: DriverContext
) {
  const persisted = yield* requirePersisted(context);
  const original = yield* readRelease(persisted);

  const intent = original.context.intents.findLast(
    (candidate) => candidate.kind === "Observe"
  );

  if (intent?.kind !== "Observe") {
    return yield* Effect.die(
      new Error("Observation requires an Observe intent")
    );
  }

  const log = yield* RunLog;
  const verdicts = yield* VerdictSink;

  const actor = yield* createEffectActor(releaseMachine, {
    snapshot: persisted,
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
          isVerdictOutcome(event.outcome)
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

  return yield* stageOutput(
    {
      ...context,
      executed: [...context.executed, intent.id],
      persisted: actor.getPersistedSnapshot(),
    },
    null
  );
}, Effect.scoped);

const finish = Effect.fn("ReleaseRun.finish")(function* finish(
  context: DriverContext
) {
  const output = yield* stageOutput(context, null);
  const sink = yield* MessageSink;
  const log = yield* RunLog;
  yield* log.append(runLines.finished({ state: output.snapshot.value }));
  yield* sink
    .send(
      `finished: ${output.snapshot.value}${releaseNote(output.snapshot.context.facts.at(-1))}`
    )
    .pipe(Effect.catch(() => Effect.void));

  return output;
});

const page = Effect.fn("ReleaseRun.page")(function* page(
  context: DriverContext
) {
  const output = yield* stageOutput(context, null);
  const sink = yield* MessageSink;
  yield* sink
    .page(
      `release ${context.config.name} ${context.config.input.target.slice(0, 8)}: ${output.snapshot.value}${releaseNote(output.snapshot.context.facts.at(-1))}`
    )
    .pipe(Effect.catch(() => Effect.void));

  return output;
});

const prepareTask = createEffectLogic({
  effect: ({ input }) => prepareReady(input.config).pipe(Effect.result),
  schemas: { input: types<DriverInput>() },
});

const admissionTask = createEffectLogic({
  effect: ({ input }) => admit(input).pipe(Effect.result),
  schemas: { input: types<DriverInput>() },
});

const planTask = createEffectLogic({
  effect: ({ input }) =>
    plan(input).pipe(Effect.mapError(executionRefusal), Effect.result),
  schemas: { input: types<DriverContext>() },
});

const reviewTask = createEffectLogic({
  effect: ({ input }) =>
    review(input).pipe(Effect.mapError(executionRefusal), Effect.result),
  schemas: { input: types<DriverContext>() },
});

const overrideTask = createEffectLogic({
  effect: ({ input }) =>
    override(input).pipe(Effect.mapError(executionRefusal), Effect.result),
  schemas: { input: types<DriverContext>() },
});

const fireTask = createEffectLogic({
  effect: ({ input }) =>
    fireRelease(input).pipe(Effect.mapError(executionRefusal), Effect.result),
  schemas: { input: types<DriverContext>() },
});

const baselineTask = createEffectLogic({
  effect: ({ input }) =>
    executeStage(input, "Baseline").pipe(
      Effect.mapError(executionRefusal),
      Effect.result
    ),
  schemas: { input: types<DriverContext>() },
});

const deployTask = createEffectLogic({
  effect: ({ input }) =>
    executeStage(input, "Deploy").pipe(
      Effect.mapError(executionRefusal),
      Effect.result
    ),
  schemas: { input: types<DriverContext>() },
});

const restoreTask = createEffectLogic({
  effect: ({ input }) =>
    executeStage(input, "Restore").pipe(
      Effect.mapError(executionRefusal),
      Effect.result
    ),
  schemas: { input: types<DriverContext>() },
});

const notifyTask = createEffectLogic({
  effect: ({ input }) =>
    executeStage(input, "NotifyOwner").pipe(
      Effect.mapError(executionRefusal),
      Effect.result
    ),
  schemas: { input: types<DriverContext>() },
});

const pageTask = createEffectLogic({
  effect: ({ input }) =>
    page(input).pipe(Effect.mapError(executionRefusal), Effect.result),
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
  actors: {
    admissionTask,
    baselineTask,
    deployTask,
    finishTask,
    fireTask,
    notifyTask,
    observeTask,
    overrideTask,
    pageTask,
    planTask,
    prepareTask,
    restoreTask,
    reviewTask,
  },
  schemas: { context: types<DriverContext>(), input: types<DriverInput>() },
}).createMachine({
  context: ({ input }) => ({
    ...input,
    error: null,
    executed: [],
    persisted: null,
    ready: null,
  }),
  initial: "admitting",
  states: {
    accepted: { type: "final" },
    admitting: {
      always: ({ context }) =>
        context.options.action === "ready"
          ? { target: "preparing" }
          : undefined,
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "refused",
              }
            : {
                context: { ...context, ...event.output.success },
                target: "planning",
              },
        src: "admissionTask",
      },
    },
    armed: { type: "final" },
    baselining: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "completing",
              }
            : { context: event.output.success.context, target: "deploying" },
        src: "baselineTask",
      },
    },
    completing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) => {
          if (Predicate.isTagged(event.output, "Failure")) {
            return {
              context: { ...context, error: event.output.failure },
              target: "refused",
            };
          }

          const { snapshot } = event.output.success;

          if (context.error !== null) {
            return { target: "refused" };
          }

          if (snapshot.matches("accepted")) {
            return { target: "accepted" };
          }

          if (snapshot.matches("restored")) {
            return { target: "restored" };
          }

          if (snapshot.matches("superseded")) {
            return { target: "superseded" };
          }

          if (snapshot.matches("armed")) {
            return { target: "armed" };
          }

          if (snapshot.matches("planned")) {
            return { target: "rehearsed" };
          }

          if (snapshot.matches("reviewHeld")) {
            return { target: "reviewHeld" };
          }

          if (snapshot.matches("held") || snapshot.matches("escalated")) {
            return { target: "paging" };
          }

          return {
            context: {
              ...context,
              error: refusals.Execution({
                harm: "Release completion has no supported terminal outcome.",
                next: "Inspect the run log and reconcile the release before starting another.",
              }),
            },
            target: "refused",
          };
        },
        src: "finishTask",
      },
    },
    deploying: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) => {
          if (Predicate.isTagged(event.output, "Failure")) {
            return {
              context: { ...context, error: event.output.failure },
              target: "completing",
            };
          }

          const output = event.output.success;

          return {
            context: output.context,
            target: output.snapshot.matches("observing")
              ? "observing"
              : "notifying",
          };
        },
        src: "deployTask",
      },
    },
    escalated: { type: "final" },
    firing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "completing",
              }
            : {
                context: event.output.success.context,
                target: event.output.success.snapshot.matches("fired")
                  ? "baselining"
                  : "completing",
              },
        src: "fireTask",
      },
    },
    held: { type: "final" },
    notifying: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) => ({
          context: Predicate.isTagged(event.output, "Failure")
            ? { ...context, error: event.output.failure }
            : event.output.success.context,
          target: "completing",
        }),
        src: "notifyTask",
      },
    },
    observing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) => {
          if (Predicate.isTagged(event.output, "Failure")) {
            return {
              context: { ...context, error: event.output.failure },
              target: "completing",
            };
          }

          const output = event.output.success;

          if (output.snapshot.matches("restoring")) {
            return { context: output.context, target: "restoring" };
          }

          return {
            context: output.context,
            target: output.snapshot.matches("escalated")
              ? "notifying"
              : "completing",
          };
        },
        src: "observeTask",
      },
    },
    overriding: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "completing",
              }
            : {
                context: event.output.success.context,
                target: event.output.success.snapshot.matches("armed")
                  ? "firing"
                  : "completing",
              },
        src: "overrideTask",
      },
    },
    paging: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) => {
          if (Predicate.isTagged(event.output, "Failure")) {
            return {
              context: { ...context, error: event.output.failure },
              target: "refused",
            };
          }

          const { snapshot } = event.output.success;

          if (snapshot.matches("held")) {
            return { target: "held" };
          }

          return { target: "escalated" };
        },
        src: "pageTask",
      },
    },
    planning: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "completing",
              }
            : {
                context: event.output.success.context,
                target:
                  event.output.success.snapshot.matches("review") &&
                  event.output.success.outcome?.status !== "recorded-would-do"
                    ? "reviewing"
                    : "completing",
              },
        src: "planTask",
      },
    },
    preparing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) =>
          Predicate.isTagged(event.output, "Failure")
            ? {
                context: { ...context, error: event.output.failure },
                target: "refused",
              }
            : {
                context: { ...context, ready: event.output.success },
                target: "ready",
              },
        src: "prepareTask",
      },
    },
    ready: { type: "final" },
    refused: { type: "final" },
    rehearsed: { type: "final" },
    restored: { type: "final" },
    restoring: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) => ({
          context: Predicate.isTagged(event.output, "Failure")
            ? { ...context, error: event.output.failure }
            : event.output.success.context,
          target: "completing",
        }),
        src: "restoreTask",
      },
    },
    reviewHeld: { type: "final" },
    reviewing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ context, event }) => {
          if (Predicate.isTagged(event.output, "Failure")) {
            return {
              context: { ...context, error: event.output.failure },
              target: "completing",
            };
          }

          const output = event.output.success;

          if (output.snapshot.matches("armed")) {
            return { context: output.context, target: "firing" };
          }

          return {
            context: output.context,
            target:
              output.snapshot.matches("reviewHeld") &&
              context.options.admission.override
                ? "overriding"
                : "completing",
          };
        },
        src: "reviewTask",
      },
    },
    superseded: { type: "final" },
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

  return { ready: snapshot.context.ready, state: snapshot.value };
}, Effect.scoped);

export const decodeReleaseConfig = (text: string) =>
  Schema.decodeEffect(Schema.fromJsonString(ReleaseConfigSchema), {
    errors: "all",
  })(text).pipe(Effect.mapError(releaseConfigRefusal));

export const runRelease = Effect.fn("ReleaseRun.run")(function* runRelease(
  configValue: ReleaseConfig,
  options: ReleaseRunOptions
) {
  const config = yield* Schema.decodeEffect(ReleaseConfigSchema, {
    errors: "all",
  })(configValue).pipe(Effect.mapError(releaseConfigRefusal));

  const admission = yield* Schema.decodeEffect(AdmissionSchema, {
    errors: "all",
  })(options.admission).pipe(Effect.mapError(releaseAdmissionRefusal));

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
