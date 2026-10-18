import {
  createEffectActor,
  fromEffect,
  waitFor,
  setupEffect,
} from "@xstate/effect";
import { Effect, Predicate, Schema } from "effect";

import { ExecutorError } from "./domain.js";
import { execute } from "./execute.js";
import { claimed, identity, Journal, records, recover } from "./journal.js";
import type { Settings } from "./services.js";
import { Outbox } from "./worker.js";

const deliver = Effect.fn("Executor.deliver")(function* deliver() {
  const journal = yield* Journal;
  const outbox = yield* Outbox;
  const entries = yield* journal.entries;

  for (const entry of entries) {
    if (
      !Predicate.isTagged(entry, "settled") ||
      entry.outcome.events.length === 0
    ) {
      continue;
    }

    const started = (yield* journal.entries).some(
      (record) =>
        (Predicate.isTagged(record, "delivering") ||
          Predicate.isTagged(record, "delivered")) &&
        identity(record.job) === identity(entry.job)
    );

    if (started) {
      continue;
    }

    yield* journal.append(records.delivering({ job: entry.job }));
    yield* outbox.post(entry.job, entry.outcome.events);
    yield* journal.append(records.delivered({ job: entry.job }));
  }
});

export const drain = Effect.fn("Executor.drain")(function* drain(
  settings: Settings
) {
  const journal = yield* Journal;
  const outbox = yield* Outbox;
  yield* deliver();
  const jobs = yield* outbox.read;

  for (const job of jobs) {
    if (claimed(yield* journal.entries, job)) {
      continue;
    }

    yield* journal.append(records.claimed({ job }));
    const outcome = yield* execute(job, settings);
    yield* journal.append(records.settled({ job, outcome }));
    yield* deliver();
  }
});

const SettingsSchema = Schema.Struct({
  baseBranch: Schema.NonEmptyString,
  baselineWorkflows: Schema.Record(Schema.String, Schema.String),
  mode: Schema.Literals(["dry-run", "live"]),
});

const taskResult = Effect.match({
  onFailure: (error: ExecutorError) => error,
  onSuccess: () => null,
});

const recoverTask = fromEffect(recover().pipe(taskResult));

const drainTask = fromEffect({
  effect: ({ input }) => drain(input).pipe(taskResult),
  schemas: { input: SettingsSchema },
});

export const executorMachine = setupEffect({
  actors: { drainTask, recoverTask },
  schemas: {
    context: Schema.Struct({
      error: Schema.NullOr(ExecutorError),
      settings: SettingsSchema,
    }),
    input: SettingsSchema,
  },
}).createMachine({
  context: ({ input }) => ({ error: null, settings: input }),
  initial: "recovering",
  states: {
    done: { type: "final" },
    draining: {
      invoke: {
        input: ({ context }) => context.settings,
        onDone: ({ context, event }) => ({
          context: { ...context, error: event.output },
          target: "done",
        }),
        src: "drainTask",
      },
    },
    recovering: {
      invoke: {
        onDone: ({ context, event }) => ({
          context: { ...context, error: event.output },
          target: event.output === null ? "draining" : "done",
        }),
        src: "recoverTask",
      },
    },
  },
});

export const runOnce = Effect.fn("Executor.runOnce")(function* runOnce(
  settings: Settings
) {
  const actor = yield* createEffectActor(executorMachine, { input: settings });
  yield* waitFor(actor, (snapshot) => snapshot.status === "done").pipe(
    Effect.orDie
  );
  const { error } = actor.getSnapshot().context;

  return yield* error === null ? Effect.void : Effect.fail(error);
}, Effect.scoped);
