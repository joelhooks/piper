import { readTrain, stateName } from "@joelhooks/piper/host";
import {
  createEffectActor,
  createEffectLogic,
  setupEffect,
  waitFor,
} from "@xstate/effect";
import { Effect, flow, Schema } from "effect";
import { types } from "xstate";

import { TrainAdmissionSchema } from "./train-domain.js";
import type { TrainAdmission, TrainStop } from "./train-domain.js";
import { admissionRefusal, endsRehearsal, notBoarded } from "./train-policy.js";
import { recordTrain } from "./train-store.js";
import {
  boardTrain,
  drainTrain,
  pollTrain,
  prepareTrain,
} from "./train-tasks.js";
import type { RunnerContext } from "./train-tasks.js";

const preparing = createEffectLogic({
  effect: ({ input }) => prepareTrain(input),
  schemas: { input: types<RunnerContext>() },
});

const boarding = createEffectLogic({
  effect: ({ input }) => boardTrain(input),
  schemas: { input: types<RunnerContext>() },
});

const riding = createEffectLogic({
  effect: ({ input }) => pollTrain(input),
  schemas: { input: types<RunnerContext>() },
});

const draining = createEffectLogic({
  effect: ({ input }) => drainTrain(input),
  schemas: { input: types<RunnerContext>() },
});

export const trainRunnerMachine = setupEffect({
  actors: { boarding, draining, preparing, riding },
  schemas: { context: types<RunnerContext>(), input: types<RunnerContext>() },
}).createMachine({
  always: ({ context }) =>
    context.stop === undefined ? undefined : { target: "#runner.stopped" },
  context: ({ input }) => input,
  id: "runner",
  initial: "preparing",
  states: {
    boarding: {
      initial: "polling",
      states: {
        draining: {
          invoke: {
            input: ({ context }) => context,
            onDone: ({ event }) => {
              const { context, intent, snapshot } = event.output;

              if (context.stop !== undefined) {
                return { context, target: "#runner.stopped" };
              }

              if (endsRehearsal(context.admission?.mode, intent)) {
                return { context, target: "#runner.rehearsed" };
              }

              if (intent === "BuildTrain") {
                return { context, target: "#runner.riding.draining" };
              }

              if (
                intent === undefined &&
                snapshot !== undefined &&
                context.admission !== undefined
              ) {
                return {
                  context: {
                    ...context,
                    stop: notBoarded(snapshot.context, context.admission),
                  },
                  target: "#runner.stopped",
                };
              }

              return { context, reenter: true, target: "draining" };
            },
            src: "draining",
          },
        },
        polling: {
          invoke: {
            input: ({ context }) => context,
            onDone: ({ event }) => {
              const { context, snapshot } = event.output;

              if (snapshot?.value === "landed") {
                return { context, target: "#runner.landed" };
              }

              return {
                context,
                target:
                  snapshot?.context.head === undefined
                    ? "draining"
                    : "#runner.riding.draining",
              };
            },
            src: "boarding",
          },
        },
      },
    },
    landed: { type: "final" },
    preparing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ event }) => {
          const { context, snapshot } = event.output;

          if (snapshot?.context.head !== undefined) {
            return { context, target: "riding.draining" };
          }

          return {
            context,
            target:
              snapshot?.context.build === undefined
                ? "boarding.polling"
                : "boarding.draining",
          };
        },
        src: "preparing",
      },
    },
    rehearsed: { type: "final" },
    riding: {
      initial: "draining",
      states: {
        draining: {
          invoke: {
            input: ({ context }) => context,
            onDone: ({ event }) => {
              const { context, intent, snapshot } = event.output;

              if (context.stop !== undefined) {
                return { context, target: "#runner.stopped" };
              }

              if (endsRehearsal(context.admission?.mode, intent)) {
                return { context, target: "#runner.rehearsed" };
              }

              if (intent === undefined && snapshot?.value === "landed") {
                return { context, target: "#runner.landed" };
              }

              return {
                context,
                reenter: true,
                target: intent === undefined ? "polling" : "draining",
              };
            },
            src: "draining",
          },
        },
        polling: {
          invoke: {
            input: ({ context }) => context,
            onDone: ({ event }) => ({
              context: event.output.context,
              target:
                event.output.snapshot?.value === "landed"
                  ? "#runner.landed"
                  : "draining",
            }),
            src: "riding",
          },
        },
      },
    },
    stopped: { type: "final" },
  },
});

export const decodeTrainAdmission = flow(
  Schema.decodeUnknownEffect(TrainAdmissionSchema, { errors: "all" }),
  Effect.mapError(admissionRefusal)
);

export const runTrain = Effect.fn("Executor.runTrain")(function* runTrain(
  decoded: TrainAdmission | TrainStop
) {
  const actor = yield* createEffectActor(trainRunnerMachine, {
    input: {
      admission: "_tag" in decoded ? undefined : decoded,
      seen: [],
      stop: "_tag" in decoded ? decoded : undefined,
      train: undefined,
      writes: 0,
    },
  });

  yield* waitFor(actor, (snapshot) => snapshot.status === "done").pipe(
    Effect.orDie
  );
  const final = actor.getSnapshot();
  const finished = final.context;

  const snapshot =
    finished.train === undefined ? undefined : yield* readTrain(finished.train);

  if (finished.stop !== undefined) {
    yield* recordTrain({
      detail: finished.stop.detail,
      harm: finished.stop.harm,
      head: snapshot?.context.head,
      next: finished.stop.next,
      pr: snapshot?.context.pr,
      state: snapshot === undefined ? "unstarted" : stateName(snapshot),
      stop: finished.stop.stop,
      writes: finished.writes,
    });
  }

  const exit =
    finished.stop?.stop ??
    (final.value === "landed" ? "landed" : "rehearsal complete");

  yield* recordTrain({ exit });

  return {
    exit,
    stop: finished.stop,
    success: final.value !== "stopped",
    writes: finished.writes,
  };
}, Effect.scoped);
