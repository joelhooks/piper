import { createEffectActor, setupEffect, waitFor } from "@xstate/effect";
import { Clock, Effect } from "effect";

import { releaseCheckMachine } from "./release-check.js";
import type { CheckInput } from "./release-check.js";

interface CheckRegion {
  readonly invoke: {
    readonly input: CheckInput & { readonly startedAt: number };
    readonly src: "check";
  };
}

const checkRegion = (input: CheckInput, startedAt: number): CheckRegion => ({
  invoke: { input: { ...input, startedAt }, src: "check" },
});

export const releaseObserversMachine = (
  inputs: readonly CheckInput[],
  startedAt: number
) => {
  const states = Object.fromEntries(
    inputs.map((input) => [
      input.intent.checks[0].name,
      checkRegion(input, startedAt),
    ])
  );

  return setupEffect({ actors: { check: releaseCheckMachine } }).createMachine({
    states,
    type: "parallel",
  });
};

export const runObservers = Effect.fn("ReleaseObservers.run")(
  function* runObservers(inputs: readonly CheckInput[]) {
    const startedAt = yield* Clock.currentTimeMillis;

    const actor = yield* createEffectActor(
      releaseObserversMachine(inputs, startedAt)
    );

    yield* waitFor(actor, (snapshot) => snapshot.status === "error").pipe(
      Effect.orDie
    );

    return yield* Effect.die(actor.getSnapshot().error);
  },
  Effect.scoped
);
