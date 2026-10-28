import {
  CarSchema,
  CheckRunSchema,
  PostedEventSchema,
  PostedSoloEventSchema,
  PrNumber,
  Sha,
} from "@joelhooks/piper/domain";
import {
  PostedReleaseEventSchema,
  ReleaseIntentSchema,
} from "@joelhooks/piper/release-domain";
import { Schema } from "effect";

const stamp = { at: Schema.Int, id: Schema.NonEmptyString };

const trainIntent = Schema.Union([
  Schema.Struct({
    ...stamp,
    base: Sha,
    branch: Schema.NonEmptyString,
    buildId: Schema.Int,
    cars: Schema.Array(CarSchema),
    kind: Schema.Literal("BuildTrain"),
    purpose: Schema.Literals(["train", "probe"]),
  }),
  Schema.Struct({
    ...stamp,
    base: Sha,
    branch: Schema.NonEmptyString,
    cars: Schema.Array(CarSchema),
    kind: Schema.Literal("OpenTrainPr"),
  }),
  Schema.Struct({ ...stamp, head: Sha, kind: Schema.Literal("PollChecks") }),
  Schema.Struct({
    ...stamp,
    cars: Schema.Array(CarSchema),
    failing: Schema.Array(CheckRunSchema),
    head: Sha,
    kind: Schema.Literal("RankSuspects"),
  }),
  Schema.Struct({ ...stamp, head: Sha, kind: Schema.Literal("RerunChecks") }),
  Schema.Struct({ ...stamp, kind: Schema.Literal("MarkReady"), pr: PrNumber }),
  Schema.Struct({
    ...stamp,
    kind: Schema.Literal("Merge"),
    matchHead: Sha,
    pr: PrNumber,
  }),
  Schema.Struct({
    ...stamp,
    kind: Schema.Literal("RemoveLabels"),
    label: Schema.NonEmptyString,
    prs: Schema.Array(PrNumber),
  }),
  Schema.Struct({
    ...stamp,
    car: CarSchema,
    excerpt: Schema.String,
    kind: Schema.Literal("NotifyOwner"),
    reason: Schema.Literals(["conflict", "culprit", "head-moved"]),
  }),
  Schema.Struct({
    ...stamp,
    kind: Schema.Literal("CloseTrainPr"),
    pr: PrNumber,
    reason: Schema.String,
  }),
]);

const soloIntent = Schema.Union([
  Schema.Struct({
    ...stamp,
    checkRunIds: Schema.Array(Schema.Int),
    checks: Schema.Array(Schema.String),
    head: Sha,
    kind: Schema.Literal("RerunFailed"),
    pr: PrNumber,
    workflowRunIds: Schema.Array(Schema.Int),
  }),
  Schema.Struct({
    ...stamp,
    checks: Schema.Array(Schema.String),
    kind: Schema.Literal("PollChecks"),
    pr: PrNumber,
    sha: Sha,
  }),
  Schema.Struct({
    ...stamp,
    base: Sha,
    checks: Schema.Array(Schema.String),
    kind: Schema.Literal("RunBaseline"),
    pr: PrNumber,
  }),
  Schema.Struct({
    ...stamp,
    excerpt: Schema.String,
    head: Sha,
    kind: Schema.Literal("NotifyOwner"),
    owner: Schema.String,
    pr: PrNumber,
    reason: Schema.Literal("regression"),
  }),
  Schema.Struct({
    ...stamp,
    detail: Schema.String,
    head: Sha,
    kind: Schema.Literal("NotifyOperator"),
    outcome: Schema.Literals(["baseRed", "infra", "unknown"]),
    pr: PrNumber,
  }),
]);

export const JobSchema = Schema.Union([
  Schema.TaggedStruct("release", {
    head: Sha,
    intent: ReleaseIntentSchema,
    repo: Schema.NonEmptyString,
    target: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("train", {
    head: Sha,
    intent: trainIntent,
    repo: Schema.NonEmptyString,
    target: Schema.NonEmptyString,
  }),
  Schema.TaggedStruct("solo", {
    head: Sha,
    intent: soloIntent,
    repo: Schema.NonEmptyString,
    target: Schema.NonEmptyString,
  }),
]);

export type Job = typeof JobSchema.Type;

export const EventSchema = Schema.Union([
  PostedReleaseEventSchema,
  PostedEventSchema,
  PostedSoloEventSchema,
]);

export type Event = typeof EventSchema.Type;

export class ExecutorError extends Schema.TaggedError<ExecutorError>()(
  "ExecutorError",
  {
    code: Schema.Literals([
      "missing-token",
      "not-found",
      "transport",
      "provider",
      "head-mismatch",
      "secondary-limit",
      "not-retryable",
      "refused",
      "decode",
      "interrupted",
      "storage",
      "configuration",
    ]),
    message: Schema.String,
    retryAfterMs: Schema.optionalKey(
      Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
    ),
  }
) {}

export const OutcomeSchema = Schema.Struct({
  error: Schema.optionalKey(ExecutorError),
  events: Schema.Array(EventSchema),
  status: Schema.Literals(["done", "failed", "recorded-would-do"]),
});

export type Outcome = typeof OutcomeSchema.Type;

export const WriteSchema = Schema.Struct({
  body: Schema.Unknown,
  method: Schema.Literals(["POST", "PATCH", "PUT", "DELETE"]),
  path: Schema.String,
});

export type Write = typeof WriteSchema.Type;

export const WouldDoSchema = Schema.Struct({
  head: Sha,
  intentId: Schema.String,
  kind: Schema.String,
  repo: Schema.String,
  wouldDo: Schema.Array(WriteSchema),
});

export type WouldDo = typeof WouldDoSchema.Type;

export type Mode = "dry-run" | "live";
