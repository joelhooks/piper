import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Effect, Predicate, Schema } from "effect";
import type { SnapshotFrom } from "xstate";

import type { TrainEvent, TrainInput } from "./domain.js";
import type { TrainContext } from "./machine.js";
import { trainMachine } from "./machine.js";

export type TrainSnapshot = SnapshotFrom<typeof trainMachine>;

export type PersistedTrain = ReturnType<
  typeof trainMachine.getPersistedSnapshot
>;

export class TrainFinished extends Schema.TaggedError<TrainFinished>()(
  "TrainFinished",
  { status: Schema.String, train: Schema.Int }
) {}

const settled = (snapshot: TrainSnapshot, token: number) =>
  snapshot.status !== "active" || snapshot.context.sync >= token;

export const openTrain = Effect.fn("Train.open")(function* openTrain(
  input: TrainInput
) {
  const actor = yield* createEffectActor(trainMachine, { input });

  return actor.getPersistedSnapshot();
}, Effect.scoped);

export const stepTrain = Effect.fn("Train.step")(function* stepTrain(
  persisted: PersistedTrain,
  events: readonly TrainEvent[]
) {
  const actor = yield* createEffectActor(trainMachine, { snapshot: persisted });
  const before = actor.getSnapshot();

  if (before.status !== "active") {
    return yield* new TrainFinished({
      status: before.status,
      train: before.context.train,
    });
  }

  const token = before.context.sync + 1;

  for (const event of events) {
    yield* send(actor, event);
  }

  yield* send(actor, { token, type: "sync" });

  yield* waitFor(actor, (snapshot) => settled(snapshot, token)).pipe(
    Effect.orDie
  );

  return actor.getPersistedSnapshot();
}, Effect.scoped);

export const readTrain = Effect.fn("Train.read")(function* readTrain(
  persisted: PersistedTrain
) {
  const actor = yield* createEffectActor(trainMachine, { snapshot: persisted });

  return actor.getSnapshot();
}, Effect.scoped);

export const stateName = (snapshot: TrainSnapshot): string =>
  Predicate.isString(snapshot.value)
    ? snapshot.value
    : Object.entries(snapshot.value)
        .map(([parent, child]) => `${parent}.${child}`)
        .join(",");

export const alarmAt = (snapshot: TrainSnapshot): number | undefined => {
  const { ciDeadlineAt, pollAt } = snapshot.context;

  const edges = [pollAt, ciDeadlineAt].filter(
    (edge): edge is number => edge !== undefined
  );

  return snapshot.status === "active" && edges.length > 0
    ? Math.min(...edges)
    : undefined;
};

export const viewTrain = (snapshot: TrainSnapshot) => {
  const context: TrainContext = snapshot.context;

  return {
    abandonedBecause: context.abandonedBecause,
    alarmAt: alarmAt(snapshot),
    bisect: context.bisect,
    build: context.build,
    cars: context.cars,
    checks: context.checks,
    directWait: context.directWait,
    dropped: context.dropped,
    facts: context.facts,
    go: context.go,
    head: context.head,
    intents: context.intents,
    landed: context.landed,
    main: context.main,
    merged: context.merged,
    plan: context.plan,
    pr: context.pr,
    ranks: context.ranks,
    red: context.red,
    rejected: context.rejected,
    repo: context.repo,
    state: stateName(snapshot),
    status: snapshot.status,
    train: context.train,
  };
};
