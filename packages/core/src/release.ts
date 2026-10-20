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
  readonly baselines: Readonly<Record<string, "pass" | "fail" | "unknown">>;
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

const overrideReview = (
  context: ReleaseContext,
  event: Extract<ReleaseEvent, { readonly type: "override" }>
) => ({
  context: {
    ...context,
    facts: [
      ...context.facts,
      {
        at: event.at,
        by: event.by,
        cause: "reviewOverride",
        kind: "override",
        reason: event.reason,
        state: "armed",
      } satisfies ReleaseFact,
    ],
    lastAt: event.at,
  },
  target: targetOf("armed"),
});

const supersede = (
  context: ReleaseContext,
  event: Extract<ReleaseEvent, { readonly type: "superseded" }>
) => ({
  context: {
    ...context,
    deadlineAt: undefined,
    facts: [
      ...context.facts,
      {
        at: event.at,
        by: event.by,
        cause: "superseded",
        evidence: event.evidence,
        kind: "superseded",
        state: "superseded",
      } satisfies ReleaseFact,
    ],
    lastAt: event.at,
  },
  target: targetOf("superseded"),
});

const restore = (context: ReleaseContext, at: number, cause: string) =>
  move(
    emit(context, at, { kind: "Restore", to: context.previousTarget }),
    "restoring",
    at,
    cause
  );

const escalate = (
  context: ReleaseContext,
  at: number,
  notification: Extract<IntentPayload, { readonly kind: "NotifyOwner" }>
) => move(emit(context, at, notification), "escalated", at, notification.cause);

const observe = (
  context: ReleaseContext,
  event: Extract<ReleaseEvent, { readonly type: "observed" }>
) => {
  if (event.outcome === "breach") {
    return restore(context, event.at, "observationBreach");
  }

  if (event.outcome === "fail") {
    if (context.baselines?.[event.check] !== "pass") {
      return escalate(context, event.at, {
        cause: "observationPreexisting",
        check: event.check,
        kind: "NotifyOwner",
      });
    }

    return context.checks.some(
      (check) => check.name === event.check && check.onFail === "restore"
    )
      ? restore(context, event.at, "observationFailed")
      : escalate(context, event.at, {
          cause: "observationFailed",
          check: event.check,
          kind: "NotifyOwner",
        });
  }

  if (context.deadlineAt !== undefined && event.at >= context.deadlineAt) {
    return escalate(context, event.at, {
      cause: "observationExpired",
      kind: "NotifyOwner",
    });
  }

  const observations = {
    ...context.observations,
    [event.check]: event.outcome,
  };

  return move(
    { ...context, observations },
    context.checks.every((check) => observations[check.name] === "pass")
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
      baselines: {},
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
                emit(
                  emit(context, event.at, {
                    checks: context.checks,
                    kind: "Baseline",
                  }),
                  event.at,
                  { kind: "Deploy", target: context.target }
                ),
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
    escalated: { type: "final" },
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
        baselined: ({ context, event }) =>
          event.at >= context.lastAt &&
          context.checks.some((check) => check.name === event.check)
            ? {
                context: {
                  ...context,
                  baselines: {
                    ...context.baselines,
                    [event.check]: event.outcome,
                  },
                  facts: [
                    ...context.facts,
                    {
                      at: event.at,
                      cause: "baselined",
                      check: event.check,
                      kind: "baseline",
                      outcome: event.outcome,
                      state: "fired",
                    } satisfies ReleaseFact,
                  ],
                  lastAt: event.at,
                },
              }
            : undefined,
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
            ? move(
                emit(context, event.at, {
                  cause: "deployFailed",
                  kind: "NotifyOwner",
                }),
                "escalated",
                event.at,
                event.reason
              )
            : undefined,
      },
    },
    held: { type: "final" },
    observing: {
      on: {
        observed: ({ context, event }) =>
          event.at >= context.lastAt &&
          context.checks.some((check) => check.name === event.check)
            ? observe(context, event)
            : undefined,
        superseded: ({ context, event }) =>
          event.at >= context.lastAt ? supersede(context, event) : undefined,
        tick: ({ context, event }) =>
          event.at >= context.lastAt &&
          context.deadlineAt !== undefined &&
          event.at >= context.deadlineAt
            ? escalate(context, event.at, {
                cause: "observationExpired",
                kind: "NotifyOwner",
              })
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
        reviewed: ({ context, event }) => {
          const heldState =
            context.overrideBy === undefined ? "held" : "reviewHeld";

          return event.at >= context.lastAt
            ? move(
                context,
                event.verdict === "approve" ? "armed" : heldState,
                event.at,
                "reviewed",
                event.by
              )
            : undefined;
        },
      },
    },
    reviewHeld: {
      on: {
        override: ({ context, event }) =>
          event.by === context.overrideBy && event.at >= context.lastAt
            ? overrideReview(context, event)
            : undefined,
      },
    },
    superseded: { type: "final" },
  },
});
