import { OperatorAcceptanceSchema } from "@joelhooks/piper-executor/acceptance";
import { PostedEventSchema, TrainInputSchema } from "@joelhooks/piper/domain";
import { Schema } from "effect";

export const ActionKind = Schema.Literals([
  "BuildTrain",
  "OpenTrainPr",
  "Merge",
  "RemoveLabels",
  "RerunChecks",
  "MarkReady",
  "CloseTrainPr",
  "NotifyOwner",
]);

export const ActionValuesSchema = Schema.Struct({
  cars: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  head: Schema.optionalKey(Schema.NonEmptyString),
  kind: ActionKind,
  label: Schema.optionalKey(Schema.String),
  members: Schema.optionalKey(Schema.Array(Schema.Int)),
  mergeSha: Schema.optionalKey(Schema.NonEmptyString),
  prs: Schema.optionalKey(Schema.Array(Schema.Int)),
});

export type ActionValues = typeof ActionValuesSchema.Type;

export const OperatorActionSchema = Schema.Struct({
  ...ActionValuesSchema.fields,
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  slot: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  source: Schema.NonEmptyString,
});

export type OperatorAction = typeof OperatorActionSchema.Type;

export const AcceptanceSchema = Schema.Struct({
  fact: OperatorAcceptanceSchema,
  head: Schema.NonEmptyString,
});

export const RawReadSchema = Schema.Struct({
  missing: Schema.Boolean,
  path: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  value: Schema.Unknown,
});

export type RawRead = typeof RawReadSchema.Type;

export const FrameSchema = Schema.Struct({
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  events: Schema.Array(PostedEventSchema),
  reads: Schema.Array(RawReadSchema),
});

export type Frame = typeof FrameSchema.Type;

export const TraceSchema = Schema.Struct({
  acceptances: Schema.Array(AcceptanceSchema),
  actions: Schema.Array(OperatorActionSchema),
  complete: Schema.Boolean,
});

export type Trace = typeof TraceSchema.Type;

export const RecordingSchema = Schema.Struct({
  frames: Schema.Array(FrameSchema),
  input: TrainInputSchema,
  since: Schema.String,
  trace: TraceSchema,
  version: Schema.Literal(1),
});

export type Recording = typeof RecordingSchema.Type;

export class ShadowError extends Schema.TaggedError<ShadowError>()(
  "ShadowError",
  {
    message: Schema.String,
  }
) {}
