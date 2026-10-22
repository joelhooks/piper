import { Array as Arr, Effect, flow, Schema } from "effect";

import {
  CiTimeoutMs,
  MaxCars,
  PollMs,
  PrNumber,
  SharedBoardingSchema,
} from "./domain.js";
import { isGlob } from "./glob.js";
import {
  DEFAULT_CARS,
  DEFAULT_CI_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  DEFAULT_TRAIN_LABEL,
} from "./policy.js";
import { schemaIssuePaths, schemaIssueReasons } from "./schema-paths.js";

const credentialPatterns: readonly RegExp[] = [
  /\b(?:gh[oprsu]|github_pat)_[A-Za-z0-9_]{16,}/u,
  /\bglpat-[A-Za-z0-9_-]{16,}/u,
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/u,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/u,
  /\bxox[abeposr]-[A-Za-z0-9-]{10,}/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\bAIza[A-Za-z0-9_-]{30,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./u,
  /\b(?:Basic|Bearer)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/u,
  /:\/\/[^\s/:@]*:[^\s/@]+@/u,
  /(?<![A-Za-z0-9])(?:access[_-]?key|api[_-]?key|client[_-]?secret|passw(?:or)?d|private[_-]?key|secret|token)=[^\s&]+/iu,
];

const mixedRun = (text: string) =>
  [...text.matchAll(/[A-Za-z0-9]{32,}/gu)].some(
    ([run]) => /[A-Z]/u.test(run) && /[a-z]/u.test(run) && /\d/u.test(run)
  );

const holdsCredential = (text: string) =>
  credentialPatterns.some((pattern) => pattern.test(text)) || mixedRun(text);

const Text = Schema.NonEmptyString.check(
  Schema.makeFilter<string>(
    (text) =>
      holdsCredential(text)
        ? "looks like an inline credential; reference it with a SecretRef"
        : undefined,
    { expected: "text without an inline credential" }
  )
);

const orDefault = <S extends Schema.Constraint>(
  schema: S,
  value: S["Encoded"]
) => Schema.withDecodingDefaultKey(Effect.succeed(value))(schema);

const distinctBy = <A>(field: keyof A & string) =>
  Schema.makeFilter<readonly A[]>((items) =>
    items.flatMap((item, index) =>
      items.findIndex((other) => other[field] === item[field]) === index
        ? []
        : [{ issue: `repeats an earlier ${field}`, path: [index, field] }]
    )
  );

const Identifier = Text.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, {
    expected: "a secret name",
  })
);

const StoreName = Text.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u, {
    expected: "a secret store or entry name",
  })
);

export const SecretRefSchema = Schema.TaggedUnion({
  CloudflareSecret: { name: Identifier },
  Env: { name: Identifier },
  Store: { name: StoreName, store: StoreName },
});

export type SecretRef = typeof SecretRefSchema.Type;

const RepoPath = Text.check(
  Schema.isPattern(/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$)).+$/u, {
    expected: "a path relative to the repository root",
  })
);

const Repo = Schema.Struct({
  base: Text.check(
    Schema.isPattern(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/u, {
      expected: "a branch name",
    })
  ),
  name: Text.check(
    Schema.isPattern(/^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u, {
      expected: "a repository name",
    })
  ),
  owner: Text.check(
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u, {
      expected: "a repository owner",
    })
  ),
});

export const ApprovalSourceSchema = Schema.TaggedUnion({
  File: { path: Text },
});

export type ApprovalSource = typeof ApprovalSourceSchema.Type;

const Labels = Schema.Struct({
  fullCi: orDefault(Text, "full-ci"),
  hold: orDefault(Text, "hold"),
  train: orDefault(Text, DEFAULT_TRAIN_LABEL),
}).check(
  Schema.makeFilter((labels) => {
    const order = [labels.train, labels.hold, labels.fullCi];

    return (["train", "hold", "fullCi"] as const).flatMap((key, index) =>
      order.indexOf(labels[key]) === index
        ? []
        : [{ issue: "repeats another merge-line label", path: [key] }]
    );
  })
);

const CheckGroups = Schema.Array(Schema.NonEmptyArray(Text));

const MergeLine = Schema.Struct({
  approval: ApprovalSourceSchema,
  checks: orDefault(
    Schema.Struct({
      direct: orDefault(CheckGroups, []),
      ignored: orDefault(Schema.Array(Text), []),
      ignoredAtBoarding: orDefault(Schema.Array(Text), []),
      train: orDefault(CheckGroups, []),
    }),
    {}
  ),
  ciTimeoutMs: orDefault(CiTimeoutMs, DEFAULT_CI_TIMEOUT_MS),
  excluded: orDefault(Schema.Array(PrNumber), []),
  labels: orDefault(Labels, {}),
  maxCars: orDefault(MaxCars, DEFAULT_CARS),
  pollMs: orDefault(PollMs, DEFAULT_POLL_MS),
  requireUpToDate: orDefault(Schema.Boolean, true),
  sharedBoarding: orDefault(SharedBoardingSchema, "ownCiGreen"),
});

const command = { args: orDefault(Schema.Array(Text), []), command: Text };

const Hook = Schema.Struct(command);

export const ShipPortSchema = Schema.TaggedUnion({
  Command: command,
  Workflow: { ref: Text, workflow: Text },
});

export type ShipPort = typeof ShipPortSchema.Type;

export const ReviewSourceSchema = Schema.TaggedUnion({
  File: { path: RepoPath },
});

export type ReviewSource = typeof ReviewSourceSchema.Type;

const Glob = Text.check(
  Schema.makeFilter<string>(isGlob, {
    expected: "a repository-relative glob built from **, * and {a,b}",
  })
);

export const PathRulesSchema = Schema.Struct({
  default: orDefault(Schema.Literals(["deploy", "skip"]), "deploy"),
  rules: orDefault(
    Schema.Array(Schema.Struct({ deploy: Schema.Boolean, glob: Glob })),
    []
  ),
});

export type PathRules = typeof PathRulesSchema.Type;

const Deploy = Schema.Struct({
  codeOnly: orDefault(Schema.Boolean, true),
  lock: Schema.optionalKey(Hook),
  migrations: orDefault(Schema.Array(RepoPath), []),
  paths: orDefault(PathRulesSchema, {}),
  prep: Schema.optionalKey(Hook),
  reviewCriteria: Schema.optionalKey(ReviewSourceSchema),
  ship: ShipPortSchema,
});

const UnitSchema = Schema.Struct({
  name: Text,
  primary: orDefault(Schema.Boolean, false),
  scheduled: orDefault(Schema.Boolean, false),
  script: Text.check(
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/u, {
      expected: "a Worker script name",
    })
  ),
});

type Unit = typeof UnitSchema.Type;

const onePrimary = Schema.makeFilter<readonly Unit[]>((units) =>
  units.flatMap((unit, index) =>
    unit.primary && units.findIndex((other) => other.primary) !== index
      ? [{ issue: "is a second primary unit", path: [index, "primary"] }]
      : []
  )
);

const PositiveMs = Schema.Int.check(Schema.isGreaterThan(0));

const Cadence = Schema.Struct({
  maxMs: orDefault(PositiveMs, 900_000),
  minMs: orDefault(PositiveMs, 15_000),
}).check(
  Schema.makeFilter(({ maxMs, minMs }) =>
    minMs <= maxMs ? undefined : { issue: "exceeds maxMs", path: ["minMs"] }
  )
);

const Scope = Schema.Array(Glob).pipe(
  Schema.refine(Arr.isReadonlyArrayNonEmpty, {
    message:
      "is empty, so the check would never be required; drop scope to require the check always",
  })
);

export const ObserveCheckSchema = Schema.Struct({
  name: Text,
  onFail: Schema.Literals(["alarm", "escalate", "restore"]),
  scope: Schema.optionalKey(Scope),
});

export type ObserveCheck = typeof ObserveCheckSchema.Type;

const Observe = Schema.Struct({
  cadence: orDefault(Cadence, {}),
  canary: Schema.optionalKey(
    Schema.Struct({
      secret: SecretRefSchema,
      url: Text.check(
        Schema.isPattern(/^https:\/\/[^\s/]+\S*$/u, {
          expected: "an https URL, so the canary secret never travels in clear",
        })
      ),
    })
  ),
  checks: Schema.NonEmptyArray(ObserveCheckSchema).check(distinctBy("name")),
  timeoutMs: PositiveMs,
});

const ClockTime = Schema.String.check(
  Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, { expected: "HH:MM" })
);

const Window = Schema.Struct({
  days: Schema.NonEmptyArray(
    Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])
  ),
  end: ClockTime,
  start: ClockTime,
}).check(
  Schema.makeFilter(({ end, start }) =>
    end === start ? { issue: "equals start", path: ["end"] } : undefined
  )
);

export const AlarmSchema = Schema.TaggedUnion({
  OutsideWindows: {
    timeZone: Text.check(
      Schema.isPattern(/^(?:UTC|[A-Z][A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/u, {
        expected: "an IANA time zone",
      })
    ),
    windows: Schema.NonEmptyArray(Window),
  },
  StartupCpuJump: {
    ratio: Schema.Finite.check(Schema.isGreaterThan(1)),
    unit: Text,
  },
});

export type Alarm = typeof AlarmSchema.Type;

const Contacts = Schema.Struct({
  alerts: orDefault(Schema.Array(Text), []),
  cc: orDefault(Schema.Array(Text), []),
  owner: Text,
  sender: orDefault(Text, "Piper"),
});

export const PiperConfigSchema = Schema.Struct({
  alarms: orDefault(Schema.Array(AlarmSchema), []),
  contacts: Contacts,
  deploy: Deploy,
  mergeLine: MergeLine,
  observe: Observe,
  repo: Repo,
  units: Schema.NonEmptyArray(UnitSchema).check(
    distinctBy("name"),
    distinctBy("script"),
    onePrimary
  ),
}).check(
  Schema.makeFilter(({ alarms, units }) =>
    alarms.flatMap((alarm, index) =>
      AlarmSchema.match(alarm, {
        OutsideWindows: () => [],
        StartupCpuJump: ({ unit }) =>
          units.some(({ name }) => name === unit)
            ? []
            : [{ issue: "names no unit", path: ["alarms", index, "unit"] }],
      })
    )
  )
);

export type PiperConfig = typeof PiperConfigSchema.Type;

export type PiperConfigInput = typeof PiperConfigSchema.Encoded;

export class PiperConfigError extends Schema.TaggedError<
  PiperConfigError,
  { readonly brand: unique symbol }
>()("PiperConfigError", {
  message: Schema.String,
  paths: Schema.Array(Schema.String),
}) {}

const named = (path: string) => (path === "" ? "the configuration root" : path);

const invalidAt = (cause: Schema.SchemaError) => {
  const paths = schemaIssuePaths(cause).map(named);

  const reasons = [
    ...new Set(
      schemaIssueReasons(cause).map(
        ({ path, reason }) => `${named(path)} ${reason}`
      )
    ),
  ].toSorted();

  return new PiperConfigError({
    message: [
      `Piper configuration is invalid at ${paths.join(", ")}`,
      ...reasons,
    ].join(". "),
    paths,
  });
};

export const decodePiperConfig = flow(
  Schema.decodeUnknownEffect(PiperConfigSchema, {
    errors: "all",
    onExcessProperty: "error",
  }),
  Effect.mapError(invalidAt)
);

export const definePiperConfig = (config: PiperConfigInput) => config;
