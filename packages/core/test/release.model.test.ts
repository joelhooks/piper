import { describe, expect, it } from "@effect/vitest";
import { createEffectActor, send, waitFor } from "@xstate/effect";
import { Effect, Schema, Struct } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import type { EventFromLogic, StateValue } from "xstate";
import { getShortestPaths } from "xstate/graph";

import {
  ReleaseCheckSchema,
  ReleaseEvents,
  ReleaseStateSchema,
} from "../src/release-domain.js";
import type {
  ReleaseEvent,
  ReleaseInput,
  ReleaseState,
} from "../src/release-domain.js";
import type { ReleaseSnapshot } from "../src/release-host.js";
import { viewRelease } from "../src/release-host.js";
import { releaseMachine } from "../src/release.js";
import {
  openModel,
  planExpectation,
  RULES,
  stepModel,
  viewOf,
} from "./release-model.js";
import type { ReleaseModel, Rule } from "./release-model.js";

const T0 = 1000;

const OWNER = "release-owner";

const OPERATOR = "operator";

const REVIEWER = "reviewer";

const between = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

const OnFail = ReleaseCheckSchema.fields.onFail;

const Policy = Schema.Struct({
  allowAbsentReview: Schema.Boolean,
  allowEmpty: Schema.Boolean,
  availability: OnFail,
  integrity: Schema.NullOr(OnFail),
  overridable: Schema.Boolean,
});

const Timing = Schema.Struct({
  blackout: between(0, 12),
  runway: between(0, 12),
  timeout: between(1, 8),
  window: between(0, 40),
});

const Scenario = Schema.Struct({ policy: Policy, timing: Timing });

const Entry = Schema.Struct({
  group: between(0, 47),
  settled: Schema.Boolean,
  variant: between(0, 63),
});

const Row = Schema.Struct({
  action: Schema.Literals(["update", "create", "delete"]),
  id: Schema.Literals(["row-a", "row-b"]),
  kind: Schema.Literals(["resource", "computed", "deferred", "unrecognized"]),
});

const Step = Schema.Struct({
  aim: between(0, 3),
  baseline: ReleaseEvents.baselined.fields.outcome,
  blackout: between(0, 24),
  check: Schema.Literals(["availability", "integrity", "latency"]),
  dt: between(-2, 4),
  kind: Schema.Literals(Struct.keys(ReleaseEvents)),
  observed: Schema.Literals(["pass", "fail", "unknown", "breach"]),
  operation: ReleaseEvents.failed.fields.operation,
  owner: Schema.Boolean,
  pick: between(0, 5),
  releaseWord: between(0, 15),
  rows: Schema.Array(Row).check(Schema.isMaxLength(2)),
  verdict: ReleaseEvents.reviewed.fields.verdict,
  window: between(0, 60),
});

type ReleasePolicy = typeof Policy.Type;

type ReleaseTiming = typeof Timing.Type;

type ReleaseScenario = typeof Scenario.Type;

type ReleaseEntry = typeof Entry.Type;

type SuffixStep = typeof Step.Type;

type Kind = ReleaseEvent["type"];

const suffixes = Arbitrary.array(Arbitrary.schema(Step), { maxLength: 30 });

const histories = {
  entry: Arbitrary.schema(Entry),
  scenario: Arbitrary.schema(Scenario),
  suffix: suffixes,
};

const SHUT_WINDOW = {
  blackout: 1,
  runway: 0,
  timeout: 1,
  window: 0,
} satisfies ReleaseTiming;

const inputOf = (
  policy: ReleasePolicy,
  timing: ReleaseTiming
): ReleaseInput => {
  const input = {
    allowAbsentReview: policy.allowAbsentReview,
    at: T0,
    blackoutUntil: T0 + timing.blackout,
    checks:
      policy.integrity === null
        ? [{ name: "availability", onFail: policy.availability }]
        : [
            { name: "availability", onFail: policy.availability },
            { name: "integrity", onFail: policy.integrity },
          ],
    docs: { diff: "synthetic diff", spec: "synthetic spec" },
    expectation: planExpectation(policy.allowEmpty),
    minimumRunwayMs: timing.runway,
    observationTimeoutMs: timing.timeout,
    previousTarget: "commit-before",
    runId: "release-model",
    target: "commit-next",
    windowEndsAt: T0 + timing.window,
  } satisfies ReleaseInput;

  return policy.overridable ? { ...input, overrideBy: OWNER } : input;
};

const ENTRY_EVENTS: readonly EventFromLogic<typeof releaseMachine>[] = [
  {
    at: T0,
    rows: [{ action: "update", id: "row-a", kind: "resource" }],
    type: "planned",
  },
  {
    at: T0,
    rows: [{ action: "delete", id: "row-a", kind: "resource" }],
    type: "planned",
  },
  { at: T0, rows: [], type: "planned" },
  ...ReleaseEvents.failed.fields.operation.literals.map(
    (operation): ReleaseEvent => ({
      at: T0,
      operation,
      reason: `${operation} failed`,
      type: "failed",
    })
  ),
  ...ReleaseEvents.reviewed.fields.verdict.literals.map(
    (verdict): ReleaseEvent => ({
      at: T0,
      by: REVIEWER,
      type: "reviewed",
      verdict,
    })
  ),
  { at: T0, type: "reviewUnavailable" },
  { at: T0, by: OWNER, reason: "owner override", type: "override" },
  { at: T0, blackoutUntil: 0, type: "window", windowEndsAt: T0 + 10_000 },
  { at: T0, by: OPERATOR, type: "fire" },
  ...["availability", "integrity"].flatMap((check): ReleaseEvent[] => [
    { at: T0, check, outcome: "pass", type: "baselined" },
    { at: T0, check, outcome: "pass", type: "observed" },
    { at: T0, check, outcome: "fail", type: "observed" },
    { at: T0, check, outcome: "breach", type: "observed" },
    {
      at: T0,
      check,
      deploymentId: "deployment-failed",
      deploymentState: "ERROR",
      outcome: "build-failed",
      type: "observed",
    },
    {
      at: T0,
      by: "commit-newer",
      check,
      deploymentId: "deployment-newer",
      outcome: "superseded",
      type: "observed",
    },
  ]),
  { at: T0, type: "deployed" },
  {
    at: T0 + 10_000,
    check: "availability",
    outcome: "pass",
    type: "observed",
  },
  { at: T0, by: OPERATOR, evidence: "a newer release", type: "superseded" },
  { at: T0, type: "restored" },
  { at: T0, by: OPERATOR, reason: "operator rejected", type: "reject" },
  { token: 0, type: "sync" },
];

const keyOf = (
  state: StateValue,
  facts: readonly { readonly cause: string }[],
  ...settled: readonly Readonly<Record<string, string>>[]
) => JSON.stringify([state, facts.at(-1)?.cause, ...settled]);

const entryKey = (snapshot: ReleaseSnapshot) =>
  keyOf(
    snapshot.value,
    snapshot.context.facts,
    snapshot.context.baselines,
    snapshot.context.observations
  );

const modelKey = (model: ReleaseModel) =>
  keyOf(model.state, model.facts, model.baselines, model.observations);

const graphs = new Map<string, ReturnType<typeof entryPaths>>();

const entryPaths = (policy: ReleasePolicy) =>
  getShortestPaths(releaseMachine, {
    events: ENTRY_EVENTS,
    input: inputOf(policy, SHUT_WINDOW),
    serializeState: entryKey,
  });

const pathsFor = (policy: ReleasePolicy) => {
  const key = JSON.stringify(policy);
  const cached = graphs.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const paths = entryPaths(policy);
  graphs.set(key, paths);

  return paths;
};

const eventsOf = (path: ReturnType<typeof entryPaths>[number]) =>
  path.steps
    .slice(1)
    .flatMap((step) => (step.event.type === "sync" ? [] : [step.event]));

const entryOf = (policy: ReleasePolicy, entry: ReleaseEntry) => {
  const groups = new Map<string, ReleaseEvent[][]>();

  const status = entry.settled ? "done" : "active";

  for (const path of pathsFor(policy).filter(
    (candidate) => candidate.state.status === status
  )) {
    const key = keyOf(path.state.value, path.state.context.facts);
    groups.set(key, [...(groups.get(key) ?? []), eventsOf(path)]);
  }

  const group = [...groups.values()][entry.group % groups.size] ?? [];

  return group[entry.variant % group.length] ?? [];
};

const reachableStates = (policy: ReleasePolicy) =>
  ReleaseStateSchema.literals.filter(
    (state) =>
      state !== "expectationCheck" &&
      (policy.overridable || state !== "reviewHeld")
  );

const FOCUS: Partial<Record<ReleaseState, readonly Kind[]>> = {
  armed: ["fire", "window"],
  fired: ["baselined", "deployed", "failed", "reject"],
  observing: [
    "observed",
    "observed",
    "observed",
    "tick",
    "superseded",
    "reject",
  ],
  planned: ["planned", "failed"],
  restoring: ["restored", "failed", "reject"],
  review: ["reviewed", "reviewUnavailable"],
  reviewHeld: ["override"],
};

const build = {
  baselined: (step, at) => ({
    at,
    check: step.check,
    outcome: step.baseline,
    type: "baselined",
  }),
  deployed: (_, at) => ({ at, type: "deployed" }),
  failed: (step, at) => ({
    at,
    operation: step.operation,
    reason: `${step.operation} failed`,
    type: "failed",
  }),
  fire: (_, at) => ({ at, by: OPERATOR, type: "fire" }),
  observed: (step, at) => {
    const { check } = step;

    if (step.releaseWord === 0) {
      return {
        at,
        check,
        deploymentId: "deployment-failed",
        deploymentState: step.owner ? "ERROR" : "CANCELED",
        outcome: "build-failed",
        type: "observed",
      };
    }

    return step.releaseWord === 1
      ? {
          at,
          by: "commit-newer",
          check,
          deploymentId: "deployment-newer",
          outcome: "superseded",
          type: "observed",
        }
      : { at, check, outcome: step.observed, type: "observed" };
  },
  override: (step, at) => ({
    at,
    by: step.owner ? OWNER : OPERATOR,
    reason: "override the review hold",
    type: "override",
  }),
  planned: (step, at) => ({ at, rows: step.rows, type: "planned" }),
  reject: (_, at) => ({
    at,
    by: OPERATOR,
    reason: "operator rejected",
    type: "reject",
  }),
  restored: (_, at) => ({ at, type: "restored" }),
  reviewUnavailable: (_, at) => ({ at, type: "reviewUnavailable" }),
  reviewed: (step, at) => ({
    at,
    by: REVIEWER,
    type: "reviewed",
    verdict: step.verdict,
  }),
  superseded: (_, at) => ({
    at,
    by: OPERATOR,
    evidence: "a newer release",
    type: "superseded",
  }),
  tick: (_, at) => ({ at, type: "tick" }),
  window: (step, at) => ({
    at,
    blackoutUntil: T0 + step.blackout,
    type: "window",
    windowEndsAt: T0 + step.window,
  }),
} satisfies {
  readonly [K in Kind]: (
    step: SuffixStep,
    at: number
  ) => Extract<ReleaseEvent, { readonly type: K }>;
};

const eventFor = (
  model: ReleaseModel,
  step: SuffixStep,
  at: number
): ReleaseEvent => {
  const focus = FOCUS[model.state] ?? [];
  const aimed = step.aim > 0 ? focus[step.pick % focus.length] : undefined;

  return build[aimed ?? step.kind](step, at);
};

interface Expected {
  readonly event: ReleaseEvent;
  readonly before: ReleaseModel;
  readonly after: ReleaseModel;
  readonly rule: Rule;
}

const modelHistory = (
  scenario: ReleaseScenario,
  entry: ReleaseEntry,
  suffix: readonly SuffixStep[]
) => {
  const input = inputOf(scenario.policy, scenario.timing);
  const expected: Expected[] = [];
  let model = openModel(input);
  let now = T0;

  const advance = (event: ReleaseEvent) => {
    const { model: after, rule } = stepModel(model, event);
    expected.push({ after, before: model, event, rule });
    model = after;
  };

  for (const event of entryOf(scenario.policy, entry)) {
    advance(event);
  }

  for (const step of suffix) {
    now += step.dt;
    advance(eventFor(model, step, now));
  }

  return { expected, input };
};

const trailOf = (expected: readonly Expected[]) =>
  expected
    .map(
      ({ after, before, event, rule }) =>
        `${event.type}@${event.at}: ${before.state} -> ${after.state} (${rule})`
    )
    .join("\n");

const unsynced = (snapshot: ReleaseSnapshot) => ({
  context: { ...snapshot.context, sync: 0 },
  status: snapshot.status,
  value: snapshot.value,
});

const replayActor = Effect.fn("replayActor")(function* replayActor(
  scenario: ReleaseScenario,
  entry: ReleaseEntry,
  suffix: readonly SuffixStep[]
) {
  const { expected, input } = modelHistory(scenario, entry, suffix);
  const actor = yield* createEffectActor(releaseMachine, { input });
  let token = 0;

  expect(viewRelease(actor.getSnapshot())).toEqual(viewOf(openModel(input)));

  for (const [index, { after, before, event }] of expected.entries()) {
    const why = trailOf(expected.slice(0, index + 1));
    const prior = actor.getSnapshot();

    if (prior.status === "active") {
      token += 1;
      const sent = token;
      yield* send(actor, event);
      yield* send(actor, { token: sent, type: "sync" });
      yield* waitFor(
        actor,
        (snapshot) =>
          snapshot.status !== "active" || snapshot.context.sync === sent
      );
    } else {
      yield* send(actor, event);
      yield* Effect.yieldNow;
      expect(actor.getSnapshot(), why).toBe(prior);
    }

    const current = actor.getSnapshot();

    if (after === before) {
      expect(unsynced(current), why).toStrictEqual(unsynced(prior));
    }

    expect(viewRelease(current), why).toEqual(viewOf(after));
  }
}, Effect.scoped);

describe("release lifecycle model", () => {
  it.prop(
    "graph entries reach every state, review holds only with an override owner, and land where the model lands",
    { policy: Policy },
    ({ policy }) => {
      const input = inputOf(policy, SHUT_WINDOW);
      const paths = pathsFor(policy);

      expect(new Set(paths.map((path) => path.state.value))).toEqual(
        new Set(reachableStates(policy))
      );

      for (const path of paths) {
        let model = openModel(input);

        for (const event of eventsOf(path)) {
          ({ model } = stepModel(model, event));
        }

        expect(modelKey(model)).toBe(entryKey(path.state));
      }
    },
    { arbitrary: { runs: 60 } }
  );

  it.effect.prop(
    "the live actor matches the model after every event, ignored events change nothing, and terminal snapshots stay identical",
    histories,
    ({ entry, scenario, suffix }) => replayActor(scenario, entry, suffix),
    { arbitrary: { runs: 300 } }
  );

  it.effect("the generator reaches every rule the model encodes", () =>
    Effect.gen(function* coverage() {
      const samples = yield* Arbitrary.sampleEffect(Arbitrary.all(histories), {
        count: 1000,
        seed: 17,
      }).pipe(Effect.orDie);

      const reached = new Map<Rule, number>();

      for (const { entry, scenario, suffix } of samples) {
        for (const { rule } of modelHistory(scenario, entry, suffix).expected) {
          reached.set(rule, (reached.get(rule) ?? 0) + 1);
        }
      }

      for (const rule of RULES) {
        expect(
          reached.get(rule) ?? 0,
          `${rule}: ${JSON.stringify(Object.fromEntries(reached))}`
        ).toBeGreaterThan(3);
      }
    })
  );
});
