import type { ReleaseIntent } from "@joelhooks/piper/release-domain";
import { createEffectLogic, setupEffect } from "@xstate/effect";
import { Context, Data, Effect, Predicate } from "effect";
import { types } from "xstate";

import type { ExecutorError, Job } from "./domain.js";
import type { ReleaseConfig } from "./release-run-domain.js";
import { RunLog, runLines } from "./release-run-log.js";
import { executeRelease } from "./release.js";
import type { ReleaseOutcome } from "./release.js";

const jobs = Data.taggedEnum<Job>();

export class CheckDelivery extends Context.Service<
  CheckDelivery,
  {
    readonly signalFailure: (error: ExecutorError) => Effect.Effect<void>;
    readonly deliver: (
      outcome: ReleaseOutcome
    ) => Effect.Effect<void, ExecutorError>;
  }
>()("piper-executor/release/CheckDelivery") {}

export interface CheckInput {
  readonly config: ReleaseConfig;
  readonly deadlineAt: number;
  readonly everyMs: number;
  readonly intent: Extract<ReleaseIntent, { readonly kind: "Observe" }>;
}

const sample = Effect.fn("ReleaseCheck.sample")(function* sample(
  input: CheckInput
) {
  const delivery = yield* CheckDelivery;
  const log = yield* RunLog;
  yield* log.append(runLines.intent({ intent: input.intent }));

  const outcome = yield* executeRelease(
    jobs.release({
      head: input.config.input.target,
      intent: { ...input.intent, deadlineAt: input.deadlineAt },
      repo: input.config.repo,
      target: input.config.input.runId,
    }),
    { baseBranch: "main", baselineWorkflows: {}, mode: "live" }
  );

  yield* delivery.deliver(outcome);

  return outcome.events.some(
    (event) =>
      Predicate.isTagged(event, "observed") && event.outcome !== "unknown"
  );
});

const sampleTask = createEffectLogic({
  effect: ({ input }) =>
    sample(input).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          CheckDelivery.use((delivery) => delivery.signalFailure(error)).pipe(
            Effect.as(false)
          ),
        onSuccess: Effect.succeed,
      })
    ),
  schemas: { input: types<CheckInput>() },
});

export const releaseCheckMachine = setupEffect({
  actors: { sampleTask },
  delays: {
    cadence: ({ context }) => context.everyMs,
    deadline: ({ context }) =>
      Math.max(0, context.deadlineAt - context.startedAt),
  },
  schemas: {
    context: types<CheckInput & { readonly startedAt: number }>(),
    input: types<CheckInput & { readonly startedAt: number }>(),
  },
}).createMachine({
  after: { deadline: { target: ".expired" } },
  context: ({ input }) => input,
  initial: "waiting",
  states: {
    expired: { type: "final" },
    sampling: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ event }) => ({
          target: event.output ? "settled" : "waiting",
        }),
        src: "sampleTask",
      },
    },
    settled: { type: "final" },
    waiting: { after: { cadence: { target: "sampling" } } },
  },
});
