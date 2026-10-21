import {
  DeparturePathSchema,
  PostedEventSchema,
  PrNumber,
  Sha,
  TrainInputSchema,
} from "@joelhooks/piper/domain";
import { Schema } from "effect";

export const TrainAdmissionSchema = Schema.Struct({
  baseBranch: Schema.NonEmptyString,
  car: Schema.Struct({ headSha: Sha, number: PrNumber }),
  goBy: Schema.NonEmptyString,
  input: TrainInputSchema,
  mode: Schema.Literals(["live", "dry-run"]),
  repo: Schema.NonEmptyString,
  tokenCommand: Schema.NonEmptyString,
  train: PrNumber,
});

export type TrainAdmission = typeof TrainAdmissionSchema.Type;

const refusal = {
  detail: Schema.Unknown,
  harm: Schema.NonEmptyString,
  next: Schema.NonEmptyString,
  stop: Schema.NonEmptyString,
};

export const TrainStopSchema = Schema.Union([
  Schema.TaggedStruct("LiveNotAdmitted", refusal),
  Schema.TaggedStruct("ResumeAfterWrites", refusal),
  Schema.TaggedStruct("TrainEnded", refusal),
  Schema.TaggedStruct("BaseMoved", refusal),
  Schema.TaggedStruct("CarMoved", refusal),
  Schema.TaggedStruct("NotBoarded", refusal),
  Schema.TaggedStruct("OutsideAdmission", refusal),
  Schema.TaggedStruct("RealRed", refusal),
  Schema.TaggedStruct("RerunRefused", refusal),
  Schema.TaggedStruct("ExecutionFailed", refusal),
  Schema.TaggedStruct("MergeRefused", refusal),
  Schema.TaggedStruct("Unavailable", refusal),
  Schema.TaggedStruct("InvalidAdmission", refusal),
]);

export type TrainStop = typeof TrainStopSchema.Type;

const timestamp = { at: Schema.String };

export const TrainRecord = Schema.Union([
  Schema.Struct({
    ...timestamp,
    car: TrainAdmissionSchema.fields.car,
    mode: TrainAdmissionSchema.fields.mode,
    repo: Schema.String,
    start: PrNumber,
  }),
  Schema.Struct({
    ...timestamp,
    base: Sha,
    cars: Schema.Array(PrNumber),
    path: DeparturePathSchema,
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({
    ...timestamp,
    id: Schema.String,
    intent: Schema.String,
    mode: TrainAdmissionSchema.fields.mode,
  }),
  Schema.Struct({
    ...timestamp,
    done: Schema.String,
    events: Schema.Array(PostedEventSchema),
    status: Schema.String,
  }),
  Schema.Struct({
    ...timestamp,
    faults: Schema.Array(
      Schema.Struct({
        conclusion: Schema.NullOr(Schema.String),
        name: Schema.String,
        runId: Schema.optional(Schema.Int),
      })
    ),
    head: Sha,
    rerun: Schema.Literal(true),
  }),
  Schema.Struct({
    ...timestamp,
    detail: Schema.Unknown,
    harm: Schema.NonEmptyString,
    head: Schema.optional(Schema.String),
    next: Schema.NonEmptyString,
    pr: Schema.optional(PrNumber),
    state: Schema.String,
    stop: Schema.String,
    writes: Schema.Int,
  }),
  Schema.Struct({
    ...timestamp,
    cars: Schema.optional(Schema.Int),
    head: Schema.optional(Schema.String),
    pr: Schema.optional(PrNumber),
    state: Schema.String,
  }),
  Schema.Struct({ exit: Schema.String }),
]);

export type TrainRecordValue = typeof TrainRecord.Type;

type Payload<T> = T extends TrainRecordValue ? Omit<T, "at"> : never;

export type TrainRecordPayload = Payload<TrainRecordValue>;

export const TrainStateSchema = Schema.Struct({
  seen: Schema.Array(Schema.String),
  train: Schema.Unknown,
  writes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type TrainState = typeof TrainStateSchema.Type;
