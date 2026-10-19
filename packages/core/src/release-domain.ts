import { Data, Schema } from "effect";

const name = Schema.NonEmptyString;

const time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ReleaseRowSchema = Schema.Struct({
  action: name,
  attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: name,
  kind: name,
});

export const ReleasePlanSchema = Schema.Array(ReleaseRowSchema);

export type ReleaseRow = typeof ReleaseRowSchema.Type;

export const ReleaseMatcherSchema = Schema.Struct({
  action: Schema.optionalKey(name),
  attributes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optionalKey(name),
  idPrefix: Schema.optionalKey(name),
  kind: Schema.optionalKey(name),
});

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ReleaseRequiredSchema = Schema.Struct({
  match: ReleaseMatcherSchema,
  max: Schema.optionalKey(count),
  min: Schema.optionalKey(count),
}).check(
  Schema.makeFilter((required) =>
    required.max === undefined || required.max >= (required.min ?? 1)
      ? undefined
      : "Required matcher maximum must be at least its minimum"
  )
);

export const ReleaseExpectationSchema = Schema.Struct({
  allowEmpty: Schema.optionalKey(Schema.Boolean),
  allowed: Schema.Array(ReleaseMatcherSchema),
  required: Schema.optionalKey(Schema.Array(ReleaseRequiredSchema)),
  stop: Schema.Array(ReleaseMatcherSchema),
});

export type ReleaseExpectation = typeof ReleaseExpectationSchema.Type;

export const ReleaseViolationSchema = Schema.Union([
  Schema.Struct({
    matcher: ReleaseMatcherSchema,
    reason: Schema.Literal("stop"),
    row: ReleaseRowSchema,
  }),
  Schema.Struct({ reason: Schema.Literal("unmatched"), row: ReleaseRowSchema }),
  Schema.Struct({
    matcher: Schema.optionalKey(ReleaseMatcherSchema),
    reason: Schema.Literal("requiredMissing"),
  }),
  Schema.Struct({
    matcher: ReleaseMatcherSchema,
    reason: Schema.Literal("countOutOfRange"),
  }),
]);

export type ReleaseViolation = typeof ReleaseViolationSchema.Type;

export const ReleaseDocsSchema = Schema.Struct({
  diff: Schema.String,
  spec: Schema.String,
});

export const ReleaseReviewRequestSchema = Schema.Struct({
  docs: ReleaseDocsSchema,
  plan: ReleasePlanSchema,
  runId: name,
});

export type ReleaseReviewRequest = typeof ReleaseReviewRequestSchema.Type;

export const ReleaseCheckSchema = Schema.Struct({
  name,
  onFail: Schema.Literals(["restore", "escalate"]),
});

export const ReleaseInputSchema = Schema.Struct({
  allowAbsentReview: Schema.Boolean,
  at: time,
  blackoutUntil: time,
  checks: Schema.NonEmptyArray(ReleaseCheckSchema),
  docs: ReleaseDocsSchema,
  expectation: ReleaseExpectationSchema,
  minimumRunwayMs: time,
  observationTimeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  overrideBy: Schema.optionalKey(name),
  previousTarget: name,
  runId: name,
  target: name,
  windowEndsAt: time,
});

export type ReleaseInput = typeof ReleaseInputSchema.Type;

const stamp = { at: time };

export const ReleaseEvents = {
  baselined: Schema.Struct({
    ...stamp,
    check: name,
    outcome: Schema.Literals(["pass", "fail", "unknown"]),
  }),
  deployed: Schema.Struct(stamp),
  failed: Schema.Struct({
    ...stamp,
    operation: Schema.Literals(["PlanRelease", "Deploy", "Restore"]),
    reason: name,
  }),
  fire: Schema.Struct({ ...stamp, by: name }),
  observed: Schema.Struct({
    ...stamp,
    check: name,
    outcome: Schema.Literals(["pass", "fail", "unknown", "breach"]),
  }),
  override: Schema.Struct({ ...stamp, by: name, reason: name }),
  planned: Schema.Struct({ ...stamp, rows: ReleasePlanSchema }),
  reject: Schema.Struct({ ...stamp, by: name, reason: name }),
  restored: Schema.Struct(stamp),
  reviewUnavailable: Schema.Struct(stamp),
  reviewed: Schema.Struct({
    ...stamp,
    by: name,
    verdict: Schema.Literals(["approve", "hold"]),
  }),
  tick: Schema.Struct(stamp),
  window: Schema.Struct({ ...stamp, blackoutUntil: time, windowEndsAt: time }),
};

export const PostedReleaseEventSchema = Schema.Union([
  Schema.TaggedStruct("baselined", ReleaseEvents.baselined.fields),
  Schema.TaggedStruct("override", ReleaseEvents.override.fields),
  Schema.TaggedStruct("planned", ReleaseEvents.planned.fields),
  Schema.TaggedStruct("reviewed", ReleaseEvents.reviewed.fields),
  Schema.TaggedStruct(
    "reviewUnavailable",
    ReleaseEvents.reviewUnavailable.fields
  ),
  Schema.TaggedStruct("window", ReleaseEvents.window.fields),
  Schema.TaggedStruct("fire", ReleaseEvents.fire.fields),
  Schema.TaggedStruct("deployed", ReleaseEvents.deployed.fields),
  Schema.TaggedStruct("observed", ReleaseEvents.observed.fields),
  Schema.TaggedStruct("tick", ReleaseEvents.tick.fields),
  Schema.TaggedStruct("restored", ReleaseEvents.restored.fields),
  Schema.TaggedStruct("failed", ReleaseEvents.failed.fields),
  Schema.TaggedStruct("reject", ReleaseEvents.reject.fields),
]);

export type PostedReleaseEvent = typeof PostedReleaseEventSchema.Type;

type EventPayloads = {
  readonly [K in keyof typeof ReleaseEvents]: (typeof ReleaseEvents)[K]["Type"];
};

export type ReleaseEvent = {
  readonly [K in keyof EventPayloads]: EventPayloads[K] & { readonly type: K };
}[keyof EventPayloads];

export const toReleaseEvent = Data.taggedEnum<PostedReleaseEvent>().$match({
  baselined: (posted): ReleaseEvent => ({ ...posted, type: "baselined" }),
  deployed: (posted): ReleaseEvent => ({ ...posted, type: "deployed" }),
  failed: (posted): ReleaseEvent => ({ ...posted, type: "failed" }),
  fire: (posted): ReleaseEvent => ({ ...posted, type: "fire" }),
  observed: (posted): ReleaseEvent => ({ ...posted, type: "observed" }),
  override: (posted): ReleaseEvent => ({ ...posted, type: "override" }),
  planned: (posted): ReleaseEvent => ({ ...posted, type: "planned" }),
  reject: (posted): ReleaseEvent => ({ ...posted, type: "reject" }),
  restored: (posted): ReleaseEvent => ({ ...posted, type: "restored" }),
  reviewUnavailable: (posted): ReleaseEvent => ({
    ...posted,
    type: "reviewUnavailable",
  }),
  reviewed: (posted): ReleaseEvent => ({ ...posted, type: "reviewed" }),
  tick: (posted): ReleaseEvent => ({ ...posted, type: "tick" }),
  window: (posted): ReleaseEvent => ({ ...posted, type: "window" }),
});

const intentStamp = { at: time, id: name };

export const ReleaseIntentSchema = Schema.Union([
  Schema.Struct({
    ...intentStamp,
    checks: Schema.NonEmptyArray(ReleaseCheckSchema),
    kind: Schema.Literal("Baseline"),
  }),
  Schema.Struct({
    ...intentStamp,
    kind: Schema.Literal("PlanRelease"),
    target: name,
  }),
  Schema.Struct({
    ...intentStamp,
    ...ReleaseReviewRequestSchema.fields,
    kind: Schema.Literal("RequestReview"),
  }),
  Schema.Struct({
    ...intentStamp,
    kind: Schema.Literal("Deploy"),
    target: name,
  }),
  Schema.Struct({
    ...intentStamp,
    checks: Schema.NonEmptyArray(ReleaseCheckSchema),
    deadlineAt: time,
    kind: Schema.Literal("Observe"),
  }),
  Schema.Struct({ ...intentStamp, kind: Schema.Literal("Restore"), to: name }),
  Schema.Struct({
    ...intentStamp,
    cause: Schema.Literals(["observationFailed", "observationPreexisting"]),
    check: name,
    kind: Schema.Literal("NotifyOwner"),
  }),
  Schema.Struct({
    ...intentStamp,
    cause: Schema.Literal("observationExpired"),
    kind: Schema.Literal("NotifyOwner"),
  }),
]);

export type ReleaseIntent = typeof ReleaseIntentSchema.Type;

export const ReleaseStateSchema = Schema.Literals([
  "planned",
  "expectationCheck",
  "review",
  "reviewHeld",
  "armed",
  "fired",
  "observing",
  "accepted",
  "escalated",
  "restoring",
  "restored",
  "held",
  "rejected",
]);

export type ReleaseState = typeof ReleaseStateSchema.Type;

const releaseTransitionFact = Schema.Struct({
  at: time,
  by: Schema.optional(name),
  cause: name,
  offending: Schema.optionalKey(Schema.Array(ReleaseViolationSchema)),
  state: ReleaseStateSchema,
});

export const ReleaseFactSchema = Schema.Union([
  Schema.Struct({
    ...releaseTransitionFact.fields,
    check: name,
    kind: Schema.Literal("baseline"),
    outcome: Schema.Literals(["pass", "fail", "unknown"]),
  }),
  Schema.Struct({
    ...releaseTransitionFact.fields,
    by: name,
    kind: Schema.Literal("override"),
    reason: name,
  }),
  releaseTransitionFact,
]);

export type ReleaseFact = typeof ReleaseFactSchema.Type;
