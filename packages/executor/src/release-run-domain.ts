import {
  ReleaseCheckSchema,
  ReleaseInputSchema,
  ReleaseIntentSchema,
  ReleasePlanSchema,
  PostedReleaseEventSchema,
} from "@joelhooks/piper/release-domain";
import { Schema } from "effect";

import { ExecutorError, OutcomeSchema, WouldDoSchema } from "./domain.js";
import { ReleaseCommandSchema, ReleaseCommandsSchema } from "./release.js";

const positive = Schema.Int.check(Schema.isGreaterThan(0));

const name = Schema.NonEmptyString;

export const ScheduledCheckSchema = Schema.Struct({
  ...ReleaseCheckSchema.fields,
  everyMs: positive,
  timeoutMs: positive,
});

export type ScheduledCheck = typeof ScheduledCheckSchema.Type;

const uniqueChecks = Schema.makeFilter<readonly ScheduledCheck[]>(
  (checks) =>
    checks.every(
      (check, index) =>
        checks.findIndex((candidate) => candidate.name === check.name) === index
    ),
  { expected: "distinct check names" }
);

export const ReleaseConfigSchema = Schema.Struct({
  commands: ReleaseCommandsSchema,
  input: Schema.Struct({
    ...ReleaseInputSchema.fields,
    checks: Schema.NonEmptyArray(ScheduledCheckSchema).check(uniqueChecks),
  }),
  name,
  predecessor: Schema.Literals(["accepted", "held", "escalated", "unknown"]),
  preflight: ReleaseCommandSchema,
  repo: name,
  rowPrefix: Schema.String,
});

export type ReleaseConfig = typeof ReleaseConfigSchema.Type;

export const AdmissionSchema = Schema.Struct({
  by: name,
  override: Schema.Boolean,
  verdict: Schema.Literals(["approve", "hold"]),
  words: name,
});

export type Admission = typeof AdmissionSchema.Type;

export const ReadySchema = Schema.Struct({
  planHash: name,
  rows: ReleasePlanSchema,
  sha: name,
});

export type Ready = typeof ReadySchema.Type;

export const RunLogLineSchema = Schema.Union([
  Schema.TaggedStruct("intent", { intent: ReleaseIntentSchema }),
  Schema.TaggedStruct("outcome", { id: name, outcome: OutcomeSchema }),
  Schema.TaggedStruct("event", { event: PostedReleaseEventSchema }),
  Schema.TaggedStruct("admission", { admission: AdmissionSchema }),
  Schema.TaggedStruct("state", { state: name }),
  Schema.TaggedStruct("finished", { state: name }),
  Schema.TaggedStruct("would-do", { record: WouldDoSchema }),
  Schema.TaggedStruct("said", {
    at: Schema.Int,
    said: Schema.String,
    wake: Schema.Boolean,
  }),
  Schema.TaggedStruct("message-failed", {
    at: Schema.Int,
    error: ExecutorError,
    said: Schema.String,
    wake: Schema.Boolean,
  }),
]);

export type RunLogLine = typeof RunLogLineSchema.Type;

const advice = { harm: name, next: name };

export const ReleaseRefusalSchema = Schema.Union([
  Schema.TaggedStruct("Configuration", advice),
  Schema.TaggedStruct("Predecessor", advice),
  Schema.TaggedStruct("Plan", advice),
  Schema.TaggedStruct("Preflight", advice),
  Schema.TaggedStruct("Ready", advice),
  Schema.TaggedStruct("Admission", advice),
  Schema.TaggedStruct("DeployAttempted", advice),
  Schema.TaggedStruct("Storage", advice),
  Schema.TaggedStruct("Execution", advice),
]);

export type ReleaseRefusal = typeof ReleaseRefusalSchema.Type;

export const VerdictRowSchema = Schema.Struct({
  evidence: Schema.String,
  outcome: Schema.Literals(["pass", "fail", "breach"]),
  sha: name,
  step: name,
  ts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type VerdictRow = typeof VerdictRowSchema.Type;
