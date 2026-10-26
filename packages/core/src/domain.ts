import { Schema } from "effect";

import type { Plan } from "./plan.js";
import { PlanSchema } from "./plan.js";
import { MAX_CARS } from "./policy.js";

export const Sha = Schema.NonEmptyString;

export const PrNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const PollMs = Schema.Int.check(
  Schema.isBetween({ maximum: 120_000, minimum: 10_000 })
);

export const CiTimeoutMs = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(60_000)
);

export const MaxCars = Schema.Int.check(
  Schema.isBetween({ maximum: MAX_CARS, minimum: 1 })
);

export const Conclusion = Schema.Literals([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
]);

export const CheckRunSchema = Schema.Struct({
  attempt: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
  ),
  baseSha: Schema.optionalKey(Sha),
  conclusion: Schema.NullOr(Conclusion),
  excerpt: Schema.optionalKey(Schema.String),
  headSha: Sha,
  id: Schema.optionalKey(Schema.Int),
  name: Schema.String,
  runId: Schema.optionalKey(Schema.Int),
  status: Schema.Literals(["queued", "in_progress", "completed"]),
});

export type CheckRun = typeof CheckRunSchema.Type;

export const WorkflowRunSchema = Schema.Struct({
  checkSuite: Schema.Int,
  createdAt: Millis,
  event: Schema.String,
  id: Schema.Int,
  workflow: Schema.Int,
});

export type WorkflowRun = typeof WorkflowRunSchema.Type;

export const CandidateSchema = Schema.Struct({
  checks: Schema.Array(CheckRunSchema),
  headSha: Sha,
  labels: Schema.Array(Schema.String),
  number: PrNumber,
  operatorReviewed: Schema.Boolean,
  owner: Schema.String,
  upToDate: Schema.Boolean,
});

export type Candidate = typeof CandidateSchema.Type;

export const CarSchema = Schema.Struct({
  headSha: Sha,
  number: PrNumber,
  owner: Schema.String,
});

export type Car = typeof CarSchema.Type;

export const ProbabilitySchema = Schema.Union([
  Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: 0 })),
  Schema.Literal("unknown"),
]);

export type Probability = typeof ProbabilitySchema.Type;

export const EvidenceSchema = Schema.Struct({
  detail: Schema.String,
  kind: Schema.Literals([
    "path",
    "checkOwner",
    "coFailure",
    "log",
    "retry",
    "baseline",
  ]),
});

export type Evidence = typeof EvidenceSchema.Type;

export const JudgeSchema = Schema.Struct({
  inputsDigest: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
});

export type Judge = typeof JudgeSchema.Type;

export const RankSchema = Schema.Struct({
  evidence: Schema.optionalKey(Schema.Array(EvidenceSchema)),
  p: ProbabilitySchema,
  pr: PrNumber,
});

export type Rank = typeof RankSchema.Type;

export const SharedBoardingSchema = Schema.Literals([
  "ownCiGreen",
  "notKnownRed",
]);

export type SharedBoarding = typeof SharedBoardingSchema.Type;

export const TrainInputSchema = Schema.Struct({
  candidateIgnoredChecks: Schema.optionalKey(Schema.Array(Schema.String)),
  candidateRequiredChecks: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyArray(Schema.String))
  ),
  ciTimeoutMs: CiTimeoutMs,
  directRequiredChecks: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyArray(Schema.String))
  ),
  ignoredChecks: Schema.Array(Schema.String),
  maxCars: MaxCars,
  pollMs: PollMs,
  repo: Schema.NonEmptyString,
  requireUpToDate: Schema.optionalKey(Schema.Boolean),
  sharedBoarding: Schema.optionalKey(SharedBoardingSchema),
  train: PrNumber,
  trainLabel: Schema.NonEmptyString,
});

export type TrainInput = typeof TrainInputSchema.Type;

const knownLandedNodes = Schema.makeFilter<{
  readonly landed: readonly string[];
  readonly plan: Plan;
}>(({ landed, plan }) =>
  landed.every((id) => plan.nodes.some((node) => node.id === id))
    ? undefined
    : "Landed node IDs must belong to the posted plan"
);

export const TrainEvents = {
  abandon: Schema.Struct({ at: Millis, reason: Schema.String }),
  buildFailed: Schema.Struct({
    at: Millis,
    buildId: Schema.Int,
    reason: Schema.String,
  }),
  built: Schema.Struct({
    at: Millis,
    buildId: Schema.Int,
    conflicted: Schema.Array(PrNumber),
    head: Sha,
    merged: Schema.Array(PrNumber),
  }),
  candidates: Schema.Struct({
    at: Millis,
    candidates: Schema.Array(CandidateSchema),
    main: Sha,
  }),
  carHeadMoved: Schema.Struct({
    actualHead: Sha,
    admittedHead: Sha,
    at: Millis,
    pr: PrNumber,
  }),
  checks: Schema.Struct({
    at: Millis,
    checks: Schema.Array(CheckRunSchema),
    head: Sha,
  }),
  depart: Schema.Struct({ at: Millis }),
  go: Schema.Struct({ at: Millis, by: Schema.NonEmptyString, head: Sha }),
  mainMoved: Schema.Struct({ at: Millis, main: Sha }),
  mergeRefused: Schema.Struct({
    at: Millis,
    head: Sha,
    reason: Schema.String,
  }),
  merged: Schema.Struct({ at: Millis, head: Sha, mergeSha: Sha }),
  plan: Schema.Struct({
    at: Millis,
    landed: Schema.Array(Schema.NonEmptyString),
    plan: PlanSchema,
  }).check(knownLandedNodes),
  prOpened: Schema.Struct({ at: Millis, pr: PrNumber }),
  rankFailed: Schema.Struct({ at: Millis, head: Sha, reason: Schema.String }),
  ranked: Schema.Struct({
    at: Millis,
    head: Sha,
    judge: JudgeSchema,
    ranks: Schema.Array(RankSchema),
  }),
  tick: Schema.Struct({ at: Millis }),
} as const;

export const PostedEventSchema = Schema.Union([
  Schema.TaggedStruct("plan", TrainEvents.plan.fields).check(knownLandedNodes),
  Schema.TaggedStruct("candidates", TrainEvents.candidates.fields),
  Schema.TaggedStruct("carHeadMoved", TrainEvents.carHeadMoved.fields),
  Schema.TaggedStruct("depart", TrainEvents.depart.fields),
  Schema.TaggedStruct("built", TrainEvents.built.fields),
  Schema.TaggedStruct("buildFailed", TrainEvents.buildFailed.fields),
  Schema.TaggedStruct("prOpened", TrainEvents.prOpened.fields),
  Schema.TaggedStruct("checks", TrainEvents.checks.fields),
  Schema.TaggedStruct("tick", TrainEvents.tick.fields),
  Schema.TaggedStruct("ranked", TrainEvents.ranked.fields),
  Schema.TaggedStruct("rankFailed", TrainEvents.rankFailed.fields),
  Schema.TaggedStruct("mainMoved", TrainEvents.mainMoved.fields),
  Schema.TaggedStruct("go", TrainEvents.go.fields),
  Schema.TaggedStruct("merged", TrainEvents.merged.fields),
  Schema.TaggedStruct("mergeRefused", TrainEvents.mergeRefused.fields),
  Schema.TaggedStruct("abandon", TrainEvents.abandon.fields),
]);

export type PostedEvent = typeof PostedEventSchema.Type;

type Payloads = {
  readonly [K in keyof typeof TrainEvents]: (typeof TrainEvents)[K]["Type"];
};

export type TrainEvent = {
  [K in keyof Payloads]: { readonly type: K } & Payloads[K];
}[keyof Payloads];

const TrainEventSchema = Schema.Union([
  Schema.Struct({
    ...TrainEvents.plan.fields,
    type: Schema.Literal("plan"),
  }).check(knownLandedNodes),
  Schema.Struct({
    ...TrainEvents.candidates.fields,
    type: Schema.Literal("candidates"),
  }),
  Schema.Struct({
    ...TrainEvents.carHeadMoved.fields,
    type: Schema.Literal("carHeadMoved"),
  }),
  Schema.Struct({
    ...TrainEvents.depart.fields,
    type: Schema.Literal("depart"),
  }),
  Schema.Struct({ ...TrainEvents.built.fields, type: Schema.Literal("built") }),
  Schema.Struct({
    ...TrainEvents.buildFailed.fields,
    type: Schema.Literal("buildFailed"),
  }),
  Schema.Struct({
    ...TrainEvents.prOpened.fields,
    type: Schema.Literal("prOpened"),
  }),
  Schema.Struct({
    ...TrainEvents.checks.fields,
    type: Schema.Literal("checks"),
  }),
  Schema.Struct({ ...TrainEvents.tick.fields, type: Schema.Literal("tick") }),
  Schema.Struct({
    ...TrainEvents.ranked.fields,
    type: Schema.Literal("ranked"),
  }),
  Schema.Struct({
    ...TrainEvents.rankFailed.fields,
    type: Schema.Literal("rankFailed"),
  }),
  Schema.Struct({
    ...TrainEvents.mainMoved.fields,
    type: Schema.Literal("mainMoved"),
  }),
  Schema.Struct({ ...TrainEvents.go.fields, type: Schema.Literal("go") }),
  Schema.Struct({
    ...TrainEvents.merged.fields,
    type: Schema.Literal("merged"),
  }),
  Schema.Struct({
    ...TrainEvents.mergeRefused.fields,
    type: Schema.Literal("mergeRefused"),
  }),
  Schema.Struct({
    ...TrainEvents.abandon.fields,
    type: Schema.Literal("abandon"),
  }),
]);

export const toTrainEvent = ({ _tag, ...payload }: PostedEvent): TrainEvent =>
  Schema.decodeUnknownSync(TrainEventSchema)({ type: _tag, ...payload });

export type Purpose = "train" | "probe";

export const DeparturePathSchema = Schema.Literals([
  "direct-land",
  "lone-board",
  "train",
]);

export type DeparturePath = typeof DeparturePathSchema.Type;

interface Stamped {
  readonly id: string;
  readonly at: number;
}

export type Intent = Stamped &
  (
    | {
        readonly kind: "BuildTrain";
        readonly buildId: number;
        readonly branch: string;
        readonly base: string;
        readonly cars: readonly Car[];
        readonly purpose: Purpose;
      }
    | {
        readonly kind: "OpenTrainPr";
        readonly branch: string;
        readonly base: string;
        readonly cars: readonly Car[];
      }
    | { readonly kind: "PollChecks"; readonly head: string }
    | {
        readonly kind: "RankSuspects";
        readonly head: string;
        readonly cars: readonly Car[];
        readonly failing: readonly CheckRun[];
      }
    | { readonly kind: "RerunChecks"; readonly head: string }
    | { readonly kind: "MarkReady"; readonly pr: number }
    | {
        readonly kind: "Merge";
        readonly pr: number;
        readonly matchHead: string;
      }
    | {
        readonly kind: "RemoveLabels";
        readonly prs: readonly number[];
        readonly label: string;
      }
    | {
        readonly kind: "NotifyOwner";
        readonly car: Car;
        readonly reason: "conflict" | "culprit" | "head-moved";
        readonly excerpt: string;
      }
    | {
        readonly kind: "CloseTrainPr";
        readonly pr: number;
        readonly reason: string;
      }
  );

export type Fact = { readonly at: number } & (
  | {
      readonly kind: "built";
      readonly buildId: number;
      readonly purpose: Purpose;
      readonly base: string;
      readonly head: string;
      readonly cars: readonly number[];
    }
  | {
      readonly kind: "departed";
      readonly path: DeparturePath;
      readonly reason: string;
      readonly base: string;
      readonly cars: readonly number[];
    }
  | {
      readonly kind: "verdict";
      readonly purpose: Purpose;
      readonly head: string;
      readonly outcome: "green" | "red" | "timeout";
    }
  | {
      readonly kind: "rebuild";
      readonly cause:
        | "main-moved"
        | "merge-refused"
        | "bisected"
        | "conflict"
        | "head-moved";
      readonly base: string;
    }
  | { readonly kind: "rerun"; readonly head: string }
  | {
      readonly kind: "dropped";
      readonly pr: number;
      readonly reason: "conflict" | "culprit" | "head-moved";
    }
  | {
      readonly kind: "judged";
      readonly head: string;
      readonly judge: Judge | undefined;

      readonly ranks: readonly {
        readonly pr: number;
        readonly p: Probability;
        readonly evidence: number;
      }[];
      readonly failed: string | undefined;
    }
  | { readonly kind: "go"; readonly head: string; readonly by: string }
  | {
      readonly kind: "merged";
      readonly head: string;
      readonly mergeSha: string;
      readonly cars: readonly number[];
    }
  | { readonly kind: "abandoned"; readonly reason: string }
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

export type IntentDraft = DistributiveOmit<Intent, "id" | "at">;

export const SoloInputSchema = Schema.Struct({
  aggregateChecks: Schema.Array(Schema.String),
  at: Millis,
  base: Sha,
  checks: Schema.Array(CheckRunSchema),
  ciTimeoutMs: CiTimeoutMs,
  head: Sha,
  ignoredChecks: Schema.Array(Schema.String),
  owner: Schema.String,
  pollMs: PollMs,
  pr: PrNumber,
  repo: Schema.NonEmptyString,
});

export type SoloInput = typeof SoloInputSchema.Type;

export const SoloClassesSchema = Schema.Struct({
  baseRed: ProbabilitySchema,
  flake: ProbabilitySchema,
  infra: ProbabilitySchema,
  regression: ProbabilitySchema,
});

export type SoloClasses = typeof SoloClassesSchema.Type;

export const SoloEvents = {
  baseline: Schema.Struct({
    at: Millis,
    base: Sha,
    checks: Schema.Array(CheckRunSchema),
  }),

  checks: Schema.Struct({
    at: Millis,
    checks: Schema.Array(CheckRunSchema),
    head: Sha,
  }),

  dismiss: Schema.Struct({ at: Millis, reason: Schema.String }),

  judged: Schema.Struct({
    at: Millis,
    classes: SoloClassesSchema,
    evidence: Schema.Array(EvidenceSchema),
    head: Sha,
    judge: JudgeSchema,
  }),

  newHead: Schema.Struct({ at: Millis, head: Sha }),

  tick: Schema.Struct({ at: Millis }),
} as const;

export const PostedSoloEventSchema = Schema.Union([
  Schema.TaggedStruct("checks", SoloEvents.checks.fields),
  Schema.TaggedStruct("baseline", SoloEvents.baseline.fields),
  Schema.TaggedStruct("judged", SoloEvents.judged.fields),
  Schema.TaggedStruct("newHead", SoloEvents.newHead.fields),
  Schema.TaggedStruct("dismiss", SoloEvents.dismiss.fields),
  Schema.TaggedStruct("tick", SoloEvents.tick.fields),
]);

export type PostedSoloEvent = typeof PostedSoloEventSchema.Type;

type SoloPayloads = {
  readonly [K in keyof typeof SoloEvents]: (typeof SoloEvents)[K]["Type"];
};

export type SoloEvent = {
  [K in keyof SoloPayloads]: { readonly type: K } & SoloPayloads[K];
}[keyof SoloPayloads];

const SoloEventSchema = Schema.Union([
  Schema.Struct({
    ...SoloEvents.checks.fields,
    type: Schema.Literal("checks"),
  }),
  Schema.Struct({
    ...SoloEvents.baseline.fields,
    type: Schema.Literal("baseline"),
  }),
  Schema.Struct({
    ...SoloEvents.judged.fields,
    type: Schema.Literal("judged"),
  }),
  Schema.Struct({
    ...SoloEvents.newHead.fields,
    type: Schema.Literal("newHead"),
  }),
  Schema.Struct({
    ...SoloEvents.dismiss.fields,
    type: Schema.Literal("dismiss"),
  }),
  Schema.Struct({ ...SoloEvents.tick.fields, type: Schema.Literal("tick") }),
]);

export const toSoloEvent = ({ _tag, ...payload }: PostedSoloEvent): SoloEvent =>
  Schema.decodeUnknownSync(SoloEventSchema)({ type: _tag, ...payload });

export type SoloOutcome =
  | "flake"
  | "infra"
  | "regression"
  | "baseRed"
  | "superseded"
  | "unknown"
  | "dismissed";

export interface SoloJudgment {
  readonly judge: Judge;
  readonly classes: SoloClasses;
  readonly evidence: readonly Evidence[];
  readonly at: number;
}

export type SoloIntent = Stamped &
  (
    | {
        readonly kind: "RerunFailed";
        readonly pr: number;
        readonly head: string;
        readonly checks: readonly string[];

        readonly workflowRunIds: readonly number[];
        readonly checkRunIds: readonly number[];
      }
    | {
        readonly kind: "PollChecks";
        readonly pr: number;
        readonly sha: string;
        readonly checks: readonly string[];
      }
    | {
        readonly kind: "RunBaseline";
        readonly pr: number;
        readonly base: string;
        readonly checks: readonly string[];
      }
    | {
        readonly kind: "NotifyOwner";
        readonly pr: number;
        readonly head: string;
        readonly owner: string;
        readonly reason: "regression";
        readonly excerpt: string;
        readonly judgment: SoloJudgment | undefined;
      }
    | {
        readonly kind: "NotifyOperator";
        readonly pr: number;
        readonly head: string;
        readonly outcome: "baseRed" | "infra" | "unknown";
        readonly detail: string;
        readonly judgment: SoloJudgment | undefined;
      }
  );

export type SoloIntentDraft = DistributiveOmit<SoloIntent, "id" | "at">;

export type AttemptRole = "original" | "rerun" | "baseline";

export type SoloFact = { readonly at: number } & (
  | {
      readonly kind: "attempt";
      readonly role: AttemptRole;
      readonly check: string;
      readonly sha: string;
      readonly id: number | undefined;
      readonly attempt: number;
      readonly conclusion: string | null;
      readonly excerpt: string | undefined;
    }
  | {
      readonly kind: "judged";
      readonly judge: Judge;
      readonly classes: SoloClasses;
      readonly evidence: number;
    }
  | {
      readonly kind: "outcome";
      readonly outcome: SoloOutcome;
      readonly checks: readonly string[];
      readonly detail: string;
    }
);
