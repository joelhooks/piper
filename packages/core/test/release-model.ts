import type {
  ReleaseEvent,
  ReleaseExpectation,
  ReleaseFact,
  ReleaseInput,
  ReleaseIntent,
  ReleaseRow,
  ReleaseState,
  ReleaseViolation,
} from "../src/release-domain.js";

type Settled = "pass" | "fail" | "unknown";

type Draft<I extends ReleaseIntent = ReleaseIntent> = I extends ReleaseIntent
  ? Omit<I, "at" | "id">
  : never;

export interface ReleaseModel {
  readonly input: ReleaseInput;
  readonly state: ReleaseState;
  readonly clock: number;
  readonly deadline: number | undefined;
  readonly blackoutUntil: number;
  readonly windowEndsAt: number;
  readonly rows: readonly ReleaseRow[];
  readonly offending: readonly ReleaseViolation[];
  readonly baselines: Readonly<Record<string, Settled>>;
  readonly observations: Readonly<Record<string, Settled>>;
  readonly intents: readonly ReleaseIntent[];
  readonly facts: readonly ReleaseFact[];
}

export const RULES = [
  "terminal",
  "stale",
  "unhandled",
  "rejectAfterDeploy",
  "wrongOperation",
  "overrideByOther",
  "fireOutsideRunway",
  "undeclaredCheck",
  "tickBeforeDeadline",
  "rejected",
  "planFailed",
  "planHeld",
  "planPassed",
  "absentReviewArms",
  "absentReviewHolds",
  "approved",
  "holdOverridable",
  "holdFinal",
  "overridden",
  "windowMoved",
  "fired",
  "baselined",
  "deployed",
  "deployFailed",
  "breachRestores",
  "preexistingEscalates",
  "failureRestores",
  "failureEscalates",
  "buildFailedEscalates",
  "observationSuperseded",
  "lateObservationEscalates",
  "observed",
  "accepted",
  "superseded",
  "deadlineEscalates",
  "restoreFailed",
  "restored",
] as const;

export type Rule = (typeof RULES)[number];

export interface ModelStep {
  readonly model: ReleaseModel;
  readonly rule: Rule;
}

type Handler = (model: ReleaseModel, event: ReleaseEvent) => ModelStep | null;

const FINAL = new Set<ReleaseState>([
  "accepted",
  "escalated",
  "held",
  "rejected",
  "restored",
  "superseded",
]);

const STOP = { action: "delete" };

export const planExpectation = (allowEmpty: boolean): ReleaseExpectation => ({
  allowEmpty,
  allowed: [
    { action: "update", kind: "resource" },
    { kind: "computed" },
    { kind: "deferred" },
  ],
  stop: [STOP],
});

const verdictOf = (row: ReleaseRow): ReleaseViolation | undefined => {
  if (row.action === "delete") {
    return { matcher: STOP, reason: "stop", row };
  }

  const allowed =
    row.kind === "computed" ||
    row.kind === "deferred" ||
    (row.kind === "resource" && row.action === "update");

  return allowed ? undefined : { reason: "unmatched", row };
};

const violationsOf = (
  rows: readonly ReleaseRow[],
  allowEmpty: boolean
): readonly ReleaseViolation[] => {
  if (rows.length === 0) {
    return allowEmpty ? [] : [{ reason: "requiredMissing" }];
  }

  return rows.flatMap((row) => {
    const verdict = verdictOf(row);

    return verdict === undefined ? [] : [verdict];
  });
};

const step = (model: ReleaseModel, rule: Rule): ModelStep => ({ model, rule });

const emit = (model: ReleaseModel, at: number, draft: Draft): ReleaseModel => ({
  ...model,
  intents: [
    ...model.intents,
    { ...draft, at, id: `${model.input.runId}/${model.intents.length + 1}` },
  ],
});

const enter = (
  model: ReleaseModel,
  state: ReleaseState,
  at: number,
  cause: string,
  by?: string
): ReleaseModel => ({
  ...model,
  clock: at,
  facts: [...model.facts, { at, by, cause, offending: model.offending, state }],
  state,
});

const escalate = (
  model: ReleaseModel,
  at: number,
  notice: Extract<Draft, { readonly kind: "NotifyOwner" }>
) => enter(emit(model, at, notice), "escalated", at, notice.cause);

const restore = (model: ReleaseModel, at: number, cause: string) =>
  enter(
    emit(model, at, { kind: "Restore", to: model.input.previousTarget }),
    "restoring",
    at,
    cause
  );

const supersede = (
  model: ReleaseModel,
  successor: {
    readonly at: number;
    readonly by: string;
    readonly cause: string;
    readonly evidence: string;
  }
): ReleaseModel => ({
  ...model,
  clock: successor.at,
  deadline: undefined,
  facts: [
    ...model.facts,
    { ...successor, kind: "superseded", state: "superseded" },
  ],
  state: "superseded",
});

const declared = (model: ReleaseModel, check: string) =>
  model.input.checks.find((declaration) => declaration.name === check);

const planned: Handler = (model, event) => {
  if (event.type === "failed") {
    return event.operation === "PlanRelease"
      ? step(enter(model, "held", event.at, event.reason), "planFailed")
      : step(model, "wrongOperation");
  }

  if (event.type !== "planned") {
    return null;
  }

  const checked = enter(
    { ...model, rows: event.rows },
    "expectationCheck",
    event.at,
    "planReceived"
  );

  const offending = violationsOf(
    event.rows,
    model.input.expectation.allowEmpty === true
  );

  if (offending.length > 0) {
    return step(
      enter({ ...checked, offending }, "held", event.at, "expectationMismatch"),
      "planHeld"
    );
  }

  const requested = emit(checked, event.at, {
    docs: model.input.docs,
    kind: "RequestReview",
    plan: event.rows,
    runId: model.input.runId,
  });

  return step(
    enter(requested, "review", event.at, "expectationPassed"),
    "planPassed"
  );
};

const review: Handler = (model, event) => {
  if (event.type === "reviewUnavailable") {
    return model.input.allowAbsentReview
      ? step(
          enter(model, "armed", event.at, "reviewUnavailable"),
          "absentReviewArms"
        )
      : step(
          enter(model, "held", event.at, "reviewUnavailable"),
          "absentReviewHolds"
        );
  }

  if (event.type !== "reviewed") {
    return null;
  }

  if (event.verdict === "approve") {
    return step(
      enter(model, "armed", event.at, "reviewed", event.by),
      "approved"
    );
  }

  return model.input.overrideBy === undefined
    ? step(enter(model, "held", event.at, "reviewed", event.by), "holdFinal")
    : step(
        enter(model, "reviewHeld", event.at, "reviewed", event.by),
        "holdOverridable"
      );
};

const reviewHeld: Handler = (model, event) => {
  if (event.type !== "override") {
    return null;
  }

  if (event.by !== model.input.overrideBy) {
    return step(model, "overrideByOther");
  }

  return step(
    {
      ...model,
      clock: event.at,
      facts: [
        ...model.facts,
        {
          at: event.at,
          by: event.by,
          cause: "reviewOverride",
          kind: "override",
          reason: event.reason,
          state: "armed",
        },
      ],
      state: "armed",
    },
    "overridden"
  );
};

const armed: Handler = (model, event) => {
  if (event.type === "window") {
    return step(
      enter(
        {
          ...model,
          blackoutUntil: event.blackoutUntil,
          windowEndsAt: event.windowEndsAt,
        },
        "armed",
        event.at,
        "windowUpdated"
      ),
      "windowMoved"
    );
  }

  if (event.type !== "fire") {
    return null;
  }

  const runwayOpen =
    event.at >= model.blackoutUntil &&
    model.windowEndsAt - event.at >= model.input.minimumRunwayMs;

  if (!runwayOpen) {
    return step(model, "fireOutsideRunway");
  }

  const baselining = emit(model, event.at, {
    checks: model.input.checks,
    kind: "Baseline",
  });

  const deploying = emit(baselining, event.at, {
    kind: "Deploy",
    target: model.input.target,
  });

  return step(enter(deploying, "fired", event.at, "fire", event.by), "fired");
};

const fired: Handler = (model, event) => {
  if (event.type === "failed") {
    return event.operation === "Deploy"
      ? step(
          enter(
            emit(model, event.at, {
              cause: "deployFailed",
              kind: "NotifyOwner",
            }),
            "escalated",
            event.at,
            event.reason
          ),
          "deployFailed"
        )
      : step(model, "wrongOperation");
  }

  if (event.type === "baselined") {
    if (declared(model, event.check) === undefined) {
      return step(model, "undeclaredCheck");
    }

    return step(
      {
        ...model,
        baselines: { ...model.baselines, [event.check]: event.outcome },
        clock: event.at,
        facts: [
          ...model.facts,
          {
            at: event.at,
            cause: "baselined",
            check: event.check,
            kind: "baseline",
            outcome: event.outcome,
            state: "fired",
          },
        ],
      },
      "baselined"
    );
  }

  if (event.type !== "deployed") {
    return null;
  }

  const deadline = event.at + model.input.observationTimeoutMs;

  const observing = emit({ ...model, deadline }, event.at, {
    checks: model.input.checks,
    deadlineAt: deadline,
    kind: "Observe",
  });

  return step(enter(observing, "observing", event.at, "deployed"), "deployed");
};

const observe = (
  model: ReleaseModel,
  event: Extract<ReleaseEvent, { readonly type: "observed" }>
): ModelStep => {
  const declaration = declared(model, event.check);

  if (declaration === undefined) {
    return step(model, "undeclaredCheck");
  }

  if (event.outcome === "breach") {
    return step(
      restore(model, event.at, "observationBreach"),
      "breachRestores"
    );
  }

  if (event.outcome === "fail") {
    if (model.baselines[event.check] !== "pass") {
      return step(
        escalate(model, event.at, {
          cause: "observationPreexisting",
          check: event.check,
          kind: "NotifyOwner",
        }),
        "preexistingEscalates"
      );
    }

    return declaration.onFail === "restore"
      ? step(restore(model, event.at, "observationFailed"), "failureRestores")
      : step(
          escalate(model, event.at, {
            cause: "observationFailed",
            check: event.check,
            kind: "NotifyOwner",
          }),
          "failureEscalates"
        );
  }

  if (event.outcome === "build-failed") {
    const { at, check, deploymentId, deploymentState } = event;

    return step(
      {
        ...emit(model, at, {
          cause: "observationBuildFailed",
          check,
          deploymentId,
          deploymentState,
          kind: "NotifyOwner",
        }),
        clock: at,
        facts: [
          ...model.facts,
          {
            at,
            cause: "observationBuildFailed",
            check,
            deploymentId,
            deploymentState,
            kind: "buildFailed",
            offending: model.offending,
            state: "escalated",
          },
        ],
        state: "escalated",
      },
      "buildFailedEscalates"
    );
  }

  if (event.outcome === "superseded") {
    return step(
      supersede(model, {
        at: event.at,
        by: event.by,
        cause: "observationSuperseded",
        evidence: event.deploymentId,
      }),
      "observationSuperseded"
    );
  }

  if (model.deadline !== undefined && event.at >= model.deadline) {
    return step(
      escalate(model, event.at, {
        cause: "observationExpired",
        kind: "NotifyOwner",
      }),
      "lateObservationEscalates"
    );
  }

  const observations = { ...model.observations, [event.check]: event.outcome };

  const allPass = model.input.checks.every(
    (check) => observations[check.name] === "pass"
  );

  return allPass
    ? step(
        enter({ ...model, observations }, "accepted", event.at, "observed"),
        "accepted"
      )
    : step(
        enter({ ...model, observations }, "observing", event.at, "observed"),
        "observed"
      );
};

const observing: Handler = (model, event) => {
  if (event.type === "observed") {
    return observe(model, event);
  }

  if (event.type === "tick") {
    return model.deadline !== undefined && event.at >= model.deadline
      ? step(
          escalate(model, event.at, {
            cause: "observationExpired",
            kind: "NotifyOwner",
          }),
          "deadlineEscalates"
        )
      : step(model, "tickBeforeDeadline");
  }

  if (event.type !== "superseded") {
    return null;
  }

  return step(
    supersede(model, {
      at: event.at,
      by: event.by,
      cause: "superseded",
      evidence: event.evidence,
    }),
    "superseded"
  );
};

const restoring: Handler = (model, event) => {
  if (event.type === "failed") {
    return event.operation === "Restore"
      ? step(enter(model, "held", event.at, event.reason), "restoreFailed")
      : step(model, "wrongOperation");
  }

  return event.type === "restored"
    ? step(enter(model, "restored", event.at, "restored"), "restored")
    : null;
};

const HANDLERS: Partial<Record<ReleaseState, Handler>> = {
  armed,
  fired,
  observing,
  planned,
  restoring,
  review,
  reviewHeld,
};

export const openModel = (input: ReleaseInput): ReleaseModel => ({
  baselines: {},
  blackoutUntil: input.blackoutUntil,
  clock: input.at,
  deadline: undefined,
  facts: [{ at: input.at, cause: "opened", state: "planned" }],
  input,
  intents: [
    {
      at: input.at,
      id: `${input.runId}/1`,
      kind: "PlanRelease",
      target: input.target,
    },
  ],
  observations: {},
  offending: [],
  rows: [],
  state: "planned",
  windowEndsAt: input.windowEndsAt,
});

export const stepModel = (
  model: ReleaseModel,
  event: ReleaseEvent
): ModelStep => {
  if (FINAL.has(model.state)) {
    return step(model, "terminal");
  }

  if (event.at < model.clock) {
    return step(model, "stale");
  }

  if (event.type === "reject") {
    return model.intents.some((intent) => intent.kind === "Deploy")
      ? step(model, "rejectAfterDeploy")
      : step(
          enter(model, "rejected", event.at, event.reason, event.by),
          "rejected"
        );
  }

  return HANDLERS[model.state]?.(model, event) ?? step(model, "unhandled");
};

export const viewOf = (model: ReleaseModel) => ({
  alarmAt: model.state === "observing" ? model.deadline : undefined,
  facts: model.facts,
  intents: model.intents,
  observations: model.observations,
  offending: model.offending,
  previousTarget: model.input.previousTarget,
  rows: model.rows,
  runId: model.input.runId,
  state: model.state,
  status: FINAL.has(model.state) ? "done" : "active",
  target: model.input.target,
});
