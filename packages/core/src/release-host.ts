import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Effect, Schema } from "effect";
import type { SnapshotFrom } from "xstate";

import type { ReleaseEvent, ReleaseInput } from "./release-domain.js";
import { releaseMachine } from "./release.js";

export type ReleaseSnapshot = SnapshotFrom<typeof releaseMachine>;

export type PersistedRelease = ReturnType<
  typeof releaseMachine.getPersistedSnapshot
>;

export class ReleaseFinished extends Schema.TaggedError<ReleaseFinished>()(
  "ReleaseFinished",
  { runId: Schema.String, status: Schema.String }
) {}

export const openRelease = Effect.fn("Release.open")(function* openRelease(
  input: ReleaseInput
) {
  const actor = yield* createEffectActor(releaseMachine, { input });

  return actor.getPersistedSnapshot();
}, Effect.scoped);

export const stepRelease = Effect.fn("Release.step")(function* stepRelease(
  persisted: PersistedRelease,
  events: readonly ReleaseEvent[]
) {
  const actor = yield* createEffectActor(releaseMachine, {
    snapshot: persisted,
  });

  const before = actor.getSnapshot();

  if (before.status !== "active") {
    return yield* new ReleaseFinished({
      runId: before.context.runId,
      status: before.status,
    });
  }

  const token = before.context.sync + 1;

  for (const event of events) {
    yield* send(actor, event);
  }

  yield* send(actor, { token, type: "sync" });
  yield* waitFor(
    actor,
    (snapshot) => snapshot.status !== "active" || snapshot.context.sync >= token
  ).pipe(Effect.orDie);

  return actor.getPersistedSnapshot();
}, Effect.scoped);

export const readRelease = Effect.fn("Release.read")(function* readRelease(
  persisted: PersistedRelease
) {
  const actor = yield* createEffectActor(releaseMachine, {
    snapshot: persisted,
  });

  return actor.getSnapshot();
}, Effect.scoped);

export const viewRelease = (snapshot: ReleaseSnapshot) => ({
  alarmAt: snapshot.matches("observing")
    ? snapshot.context.deadlineAt
    : undefined,
  facts: snapshot.context.facts,
  intents: snapshot.context.intents,
  observations: snapshot.context.observations,
  offending: snapshot.context.offending,
  previousTarget: snapshot.context.previousTarget,
  rows: snapshot.context.rows,
  runId: snapshot.context.runId,
  state: snapshot.value,
  status: snapshot.status,
  target: snapshot.context.target,
});
