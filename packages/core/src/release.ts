import { setupEffect } from "@xstate/effect";
import { Schema } from "effect";
import { types } from "xstate";

import { ReleaseEvents, ReleaseInputSchema } from "./release-domain.js";
import type {
  ReleaseEvent,
  ReleaseFact,
  ReleaseInput,
  ReleaseIntent,
  ReleaseRow,
  ReleaseState,
  ReleaseViolation,
} from "./release-domain.js";
import { checkReleaseExpectation, releaseRunway } from "./release-policy.js";

export interface ReleaseContext extends ReleaseInput {
  readonly rows: readonly ReleaseRow[];
  readonly offending: readonly ReleaseViolation[];
  readonly observations: Readonly<Record<string, "pass" | "fail" | "unknown">>;
  readonly deadlineAt: number | undefined;
  readonly facts: readonly ReleaseFact[];
  readonly intents: readonly ReleaseIntent[];
  readonly lastAt: number;
  readonly sync: number;
}

type IntentPayload = ReleaseIntent extends infer I
  ? I extends ReleaseIntent
    ? Omit<I, "at" | "id">
    : never
  : never;

const emit = (
  context: ReleaseContext,
  at: number,
  intent: IntentPayload
): ReleaseContext => ({
  ...context,
  intents: [
    ...context.intents,
    { ...intent, at, id: `${context.runId}/${context.intents.length + 1}` },
  ],
});

const targetOf = (state: ReleaseState): `#release.${ReleaseState}` =>
  `#release.${state}`;

const move = (
  context: ReleaseContext,
  state: ReleaseState,
  at: number,
  cause: string,
  by?: string
) => ({
  context: {
    ...context,
    facts: [
      ...context.facts,
      { at, by, cause, offending: context.offending, state },
    ],
    lastAt: at,
  },
  target: targetOf(state),
});

const restore = (context: ReleaseContext, at: number, cause: string) =>
  move(
    emit(context, at, { kind: "Restore", to: context.previousTarget }),
    "restoring",
    at,
    cause
  );

const observe = (
  context: ReleaseContext,
  event: Extract<ReleaseEvent, { readonly type: "observed" }>
) => {
  if (
    event.outcome === "fail" ||
    (context.deadlineAt !== undefined && event.at >= context.deadlineAt)
  ) {
    return restore(
      context,
      event.at,
      event.outcome === "fail" ? "observationFailed" : "observationExpired"
    );
  }

  const observations = {
    ...context.observations,
    [event.check]: event.outcome,
  };

  return move(
    { ...context, observations },
    context.checks.every((check) => observations[check] === "pass")
      ? "accepted"
      : "observing",
    event.at,
    "observed"
  );
};

const initialContext = (input: ReleaseInput): ReleaseContext =>
  emit(
    {
      ...input,
      deadlineAt: undefined,
      facts: [{ at: input.at, cause: "opened", state: "planned" }],
      intents: [],
      lastAt: input.at,
      observations: {},
      offending: [],
      rows: [],
      sync: 0,
    },
    input.at,
    { kind: "PlanRelease", target: input.target }
  );

export const releaseMachine = setupEffect({
  schemas: {
    context: types<ReleaseContext>(),
    events: { ...ReleaseEvents, sync: Schema.Struct({ token: Schema.Int }) },
    input: ReleaseInputSchema,
  },
}).createMachine({
  context: ({ input }: { input: ReleaseInput }) => initialContext(input),
  id: "release",
  initial: "planned",
  on: {
    reject: ({ context, event }) =>
      event.at >= context.lastAt &&
      context.intents.every((intent) => intent.kind !== "Deploy")
        ? move(context, "rejected", event.at, event.reason, event.by)
        : undefined,
    sync: ({ context, event }) => ({
      context: { ...context, sync: event.token },
    }),
  },
  states: {
    accepted: { type: "final" },
    armed: {
      on: {
        fire: ({ context, event }) =>
          event.at >= context.lastAt && releaseRunway(context, event.at)
            ? move(
                emit(context, event.at, {
                  kind: "Deploy",
                  target: context.target,
                }),
                "fired",
                event.at,
                "fire",
                event.by
              )
            : undefined,
        window: ({ context, event }) =>
          event.at >= context.lastAt
            ? move(
                {
                  ...context,
                  blackoutUntil: event.blackoutUntil,
                  windowEndsAt: event.windowEndsAt,
                },
                "armed",
                event.at,
                "windowUpdated"
              )
            : undefined,
      },
    },
    expectationCheck: {
      always: ({ context }) => {
        const offending = checkReleaseExpectation(
          context.rows,
          context.expectation
        );

        return offending.length > 0
          ? move(
              { ...context, offending },
              "held",
              context.lastAt,
              "expectationMismatch"
            )
          : move(
              emit(context, context.lastAt, {
                docs: context.docs,
                kind: "RequestReview",
                plan: context.rows,
                runId: context.runId,
              }),
              "review",
              context.lastAt,
              "expectationPassed"
            );
      },
    },
    fired: {
      on: {
        deployed: ({ context, event }) =>
          event.at >= context.lastAt
            ? move(
                emit(
                  {
                    ...context,
                    deadlineAt: event.at + context.observationTimeoutMs,
                  },
                  event.at,
                  {
                    checks: context.checks,
                    deadlineAt: event.at + context.observationTimeoutMs,
                    kind: "Observe",
                  }
                ),
                "observing",
                event.at,
                "deployed"
              )
            : undefined,
        failed: ({ context, event }) =>
          event.at >= context.lastAt && event.operation === "Deploy"
            ? restore(context, event.at, event.reason)
            : undefined,
      },
    },
    held: { type: "final" },
    observing: {
      on: {
        observed: ({ context, event }) =>
          event.at >= context.lastAt && context.checks.includes(event.check)
            ? observe(context, event)
            : undefined,
        tick: ({ context, event }) =>
          event.at >= context.lastAt &&
          context.deadlineAt !== undefined &&
          event.at >= context.deadlineAt
            ? restore(context, event.at, "observationExpired")
            : undefined,
      },
    },
    planned: {
      on: {
        failed: ({ context, event }) =>
          event.at >= context.lastAt && event.operation === "PlanRelease"
            ? move(context, "held", event.at, event.reason)
            : undefined,
        planned: ({ context, event }) =>
          event.at >= context.lastAt
            ? move(
                { ...context, rows: event.rows },
                "expectationCheck",
                event.at,
                "planReceived"
              )
            : undefined,
      },
    },
    rejected: { type: "final" },
    restored: { type: "final" },
    restoring: {
      on: {
        failed: ({ context, event }) =>
          event.at >= context.lastAt && event.operation === "Restore"
            ? move(context, "held", event.at, event.reason)
            : undefined,
        restored: ({ context, event }) =>
          event.at >= context.lastAt
            ? move(context, "restored", event.at, "restored")
            : undefined,
      },
    },
    review: {
      on: {
        reviewUnavailable: ({ context, event }) =>
          event.at >= context.lastAt
            ? move(
                context,
                context.allowAbsentReview ? "armed" : "held",
                event.at,
                "reviewUnavailable"
              )
            : undefined,
        reviewed: ({ context, event }) =>
          event.at >= context.lastAt
            ? move(
                context,
                event.verdict === "approve" ? "armed" : "held",
                event.at,
                "reviewed",
                event.by
              )
            : undefined,
      },
    },
  },
});
