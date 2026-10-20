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
import { admissionRefusal } from "./train-policy.js";
import { recordTrain } from "./train-store.js";
import { drainTrain, pollTrain, prepareTrain } from "./train-tasks.js";
import type { RunnerContext } from "./train-tasks.js";

const preparing = createEffectLogic({
  effect: ({ input }) => prepareTrain(input),
  schemas: { input: types<RunnerContext>() },
});

const polling = createEffectLogic({
  effect: ({ input }) => pollTrain(input),
  schemas: { input: types<RunnerContext>() },
});

const draining = createEffectLogic({
  effect: ({ input }) => drainTrain(input),
  schemas: { input: types<RunnerContext>() },
});

const destination = (context: RunnerContext) => {
  if (context.stop !== undefined) {
    return "stopped";
  }

  if (context.result === "landed") {
    return "landed";
  }

  return context.result === "rehearsal complete" ? "rehearsed" : undefined;
};

export const trainRunnerMachine = setupEffect({
  actors: { draining, polling, preparing },
  schemas: { context: types<RunnerContext>(), input: types<RunnerContext>() },
}).createMachine({
  context: ({ input }) => input,
  initial: "preparing",
  states: {
    draining: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ event }) => ({
          context: event.output,
          reenter: true,
          target:
            destination(event.output) ??
            (event.output.drained ? "polling" : "draining"),
        }),
        src: "draining",
      },
    },
    landed: { type: "final" },
    polling: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ event }) => ({
          context: event.output,
          target: destination(event.output) ?? "draining",
        }),
        src: "polling",
      },
    },
    preparing: {
      invoke: {
        input: ({ context }) => context,
        onDone: ({ event }) => ({
          context: event.output,
          target: destination(event.output) ?? "polling",
        }),
        src: "preparing",
      },
    },
    rehearsed: { type: "final" },
    stopped: { type: "final" },
  },
});

export const decodeTrainAdmission = flow(
  Schema.decodeUnknownEffect(TrainAdmissionSchema),
  Effect.mapError(admissionRefusal)
);

export const runTrain = Effect.fn("Executor.runTrain")(function* runTrain(
  decoded: TrainAdmission | TrainStop
) {
  const context: RunnerContext = {
    admission: "_tag" in decoded ? undefined : decoded,
    built: false,
    departed: false,
    drained: false,
    result: undefined,
    seen: [],
    stop: "_tag" in decoded ? decoded : undefined,
    train: undefined,
    writes: 0,
  };

  const actor = yield* createEffectActor(trainRunnerMachine, {
    input: context,
  });

  yield* waitFor(actor, (snapshot) => snapshot.status === "done").pipe(
    Effect.orDie
  );
  const finished = actor.getSnapshot().context;

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

  const exit = finished.stop?.stop ?? finished.result ?? "runner stopped";
  yield* recordTrain({ exit });

  return {
    exit,
    stop: finished.stop,
    success: finished.result !== undefined,
    writes: finished.writes,
  };
}, Effect.scoped);
