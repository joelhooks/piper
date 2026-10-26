import { Schema } from "effect";

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const AplName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/u));

export const CheckNames = ["readback", "errors", "canary"] as const;

export type CheckName = (typeof CheckNames)[number];

export type Phase = "baseline" | "release";

export const CanarySchema = Schema.Struct({
  contains: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 100 })),
  url: Schema.String.check(Schema.isPattern(/^https?:\/\/\S+$/u)),
});

export type Canary = typeof CanarySchema.Type;

export const ObserveConfigSchema = Schema.Struct({
  axiom: Schema.Struct({
    dataset: AplName,
    filter: Schema.NonEmptyString,
    hardFloorErrors: NonNegativeInt,
    maxRateRatio: Schema.Finite.check(Schema.isGreaterThan(0)),
    minRequests: PositiveInt,
    statusField: AplName,
    windowMinutes: PositiveInt,
  }),
  canary: Schema.Array(CanarySchema),
  sha: Schema.String.check(
    Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u)
  ),
  vercel: Schema.Struct({
    projectId: Schema.NonEmptyString,
    teamId: Schema.NonEmptyString,
  }),
});

export type ObserveConfig = typeof ObserveConfigSchema.Type;

export type AxiomSettings = ObserveConfig["axiom"];

export interface Counts {
  readonly errors: number;
  readonly requests: number;
}

export interface Window {
  readonly end: string;
  readonly readyAt: string;
  readonly start: string;
}

export interface CanaryFailure {
  readonly reason: string;
  readonly url: string;
}

export type Containment = "yes" | "no" | "unknown";

export type ReleaseOutcome =
  | {
      readonly deploymentId: string;
      readonly outcome: "build-failed";
      readonly state: "ERROR" | "CANCELED";
      readonly url: string;
    }
  | {
      readonly by: string;
      readonly deploymentId: string;
      readonly outcome: "superseded";
    };

export type Observation =
  | ReleaseOutcome
  | { readonly outcome: "unknown"; readonly reason: string }
  | {
      readonly deploymentId: string;
      readonly outcome: "pass";
      readonly readyAt: string;
      readonly url: string;
    }
  | {
      readonly deploymentId: string;
      readonly outcome: "pass" | "fail" | "unknown";
      readonly state: string;
      readonly url: string;
    }
  | {
      readonly after: Counts;
      readonly before: Counts;
      readonly outcome: "pass" | "breach" | "unknown";
      readonly window: Window;
    }
  | {
      readonly before: Counts;
      readonly outcome: "pass";
      readonly window: Omit<Window, "readyAt">;
    }
  | {
      readonly outcome: "fail";
      readonly failures: readonly CanaryFailure[];
    }
  | { readonly outcome: "unknown"; readonly unreachable: readonly string[] }
  | { readonly checked: number; readonly outcome: "pass" };

export class ObserveError extends Schema.TaggedError<
  ObserveError,
  { readonly brand: unique symbol }
>()("ObserveError", { reason: Schema.String }) {}
