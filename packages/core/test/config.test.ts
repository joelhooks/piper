import { describe, expect, expectTypeOf, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import example from "../examples/piper.config.ts";
import type { Alarm, PiperConfig } from "../src/config.js";
import {
  ApprovalSourceSchema,
  decodePiperConfig,
  definePiperConfig,
  SecretRefSchema,
  ShipPortSchema,
} from "../src/config.js";
import { TrainInputSchema } from "../src/domain.js";
import { input } from "./fixtures.js";

type Path = readonly (number | string)[];

interface Node {
  readonly path: Path;
  readonly value: Schema.Json;
}

const isList = Schema.is(Schema.Array(Schema.Json));

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Json));

const nodes = (value: Schema.Json, path: Path = []): readonly Node[] => {
  if (isList(value)) {
    return [
      { path, value },
      ...value.flatMap((item, index) => nodes(item, [...path, index])),
    ];
  }

  if (isRecord(value)) {
    return [
      { path, value },
      ...Object.entries(value).flatMap(([key, item]) =>
        nodes(item, [...path, key])
      ),
    ];
  }

  return [{ path, value }];
};

const update = (
  value: Schema.Json,
  path: Path,
  change: (node: Schema.Json) => Schema.Json
): Schema.Json => {
  const [head, ...rest] = path;

  if (head === undefined) {
    return change(value);
  }

  if (isList(value)) {
    return value.map((item, index) =>
      index === head ? update(item, rest, change) : item
    );
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === head ? update(item, rest, change) : item,
      ])
    );
  }

  return value;
};

const set = (value: Schema.Json, path: Path, next: Schema.Json) =>
  update(value, path, () => next);

const extend = (
  value: Schema.Json,
  path: Path,
  key: string,
  next: Schema.Json
) =>
  update(value, path, (node) =>
    isRecord(node)
      ? Object.fromEntries([...Object.entries(node), [key, next]])
      : node
  );

const dotted = (path: Path) => path.join(".");

const json = Schema.decodeSync(Schema.Json)(example);

const rejection = (candidate: Schema.Json) =>
  decodePiperConfig(candidate).pipe(
    Effect.match({
      onFailure: ({ message, paths }) => ({ message, paths }),
      onSuccess: () => ({ message: "", paths: [] }),
    })
  );

const pathsOf = (candidate: Schema.Json) =>
  rejection(candidate).pipe(Effect.map(({ paths }) => paths));

const filler = (length: number) => "x7".repeat(length / 2);

const credentials = [
  ["gh", "p_", filler(36)],
  ["github", "_pat_", filler(40)],
  ["gl", "pat-", filler(20)],
  ["s", "k-", filler(32)],
  ["rk", "_live_", filler(24)],
  ["xo", "xb-", filler(12)],
  ["AK", "IA", "X7".repeat(8)],
  ["AI", "za", filler(35)],
  ["-----BEGIN ", "RSA PRIVATE", " KEY-----"],
  ["ey", "J", filler(12), ".ey", "J", filler(12), ".", filler(12)],
  ["Bearer ", filler(24)],
  ["https://deploy:", filler(12), "@shop.example"],
  ["https://shop.example/hook?tok", "en=", filler(12)],
  ["--api", "-key=", filler(12)],
  ["Ab3".repeat(12)],
].map((parts) => parts.join(""));

const stringLeaves = nodes(json).filter((node) =>
  Schema.is(Schema.String)(node.value)
);

const minimal = definePiperConfig({
  contacts: { owner: "release-owner@shop.example" },
  deploy: {
    ship: ShipPortSchema.cases.Command.make({ args: [], command: "pnpm" }),
  },
  mergeLine: {
    approval: ApprovalSourceSchema.cases.File.make({ path: ".piper/go.tsv" }),
  },
  observe: {
    checks: [{ name: "readback", onFail: "restore" }],
    timeoutMs: 600_000,
  },
  repo: { base: "main", name: "shop", owner: "acme" },
  units: [{ name: "app", script: "shop-app" }],
});

describe("PiperConfig", () => {
  it.effect("decodes the acme/shop example with three Workers", () =>
    Effect.gen(function* exampleConfig() {
      const config = yield* decodePiperConfig(example);

      expect(config.repo).toEqual({
        base: "main",
        name: "shop",
        owner: "acme",
      });
      expect(config.units).toEqual([
        {
          name: "storefront",
          primary: true,
          scheduled: false,
          script: "shop-storefront",
        },
        { name: "api", primary: false, scheduled: false, script: "shop-api" },
        { name: "jobs", primary: false, scheduled: true, script: "shop-jobs" },
      ]);
      expect(config.observe.canary?.secret).toEqual(
        SecretRefSchema.cases.Env.make({ name: "SHOP_CANARY_TOKEN" })
      );
      expect(config.observe.checks.at(-1)).toEqual({
        name: "jobs",
        onFail: "escalate",
        scope: ["{jobs,scheduler}/**"],
      });
    })
  );

  it.effect("fills every default from the repository's existing policy", () =>
    Effect.gen(function* defaults() {
      const config = yield* decodePiperConfig(minimal);

      expect(config).toEqual({
        alarms: [],
        contacts: {
          alerts: [],
          cc: [],
          owner: "release-owner@shop.example",
          sender: "Piper",
        },
        deploy: {
          codeOnly: true,
          migrations: [],
          paths: { default: "deploy", rules: [] },
          ship: ShipPortSchema.cases.Command.make({
            args: [],
            command: "pnpm",
          }),
        },
        mergeLine: {
          approval: ApprovalSourceSchema.cases.File.make({
            path: ".piper/go.tsv",
          }),
          checks: { direct: [], ignored: [], ignoredAtBoarding: [], train: [] },
          ciTimeoutMs: 3_600_000,
          excluded: [],
          labels: { fullCi: "full-ci", hold: "hold", train: "train" },
          maxCars: 8,
          pollMs: 90_000,
          requireUpToDate: true,
          sharedBoarding: "ownCiGreen",
        },
        observe: {
          cadence: { maxMs: 900_000, minMs: 15_000 },
          checks: [{ name: "readback", onFail: "restore" }],
          timeoutMs: 600_000,
        },
        repo: { base: "main", name: "shop", owner: "acme" },
        units: [
          { name: "app", primary: false, scheduled: false, script: "shop-app" },
        ],
      } satisfies PiperConfig);
    })
  );
});

describe("inline secrets", () => {
  it.effect("every SecretRef variant names a secret without holding it", () =>
    Effect.gen(function* references() {
      const secret = ["observe", "canary", "secret"];

      for (const ref of [
        SecretRefSchema.cases.Env.make({ name: "SHOP_CANARY_TOKEN" }),
        SecretRefSchema.cases.Store.make({
          name: "shop/canary",
          store: "vault",
        }),
        SecretRefSchema.cases.CloudflareSecret.make({ name: "CANARY_TOKEN" }),
      ]) {
        expect(yield* pathsOf(set(json, secret, ref))).toEqual([]);
      }

      expect(yield* pathsOf(set(json, secret, "SHOP_CANARY_TOKEN"))).toEqual([
        "observe.canary.secret",
      ]);
      expect(
        yield* pathsOf(extend(json, secret, "value", "shop-canary"))
      ).toEqual(["observe.canary.secret.value"]);
    })
  );

  it.effect("accepts ordinary text that only resembles a credential", () =>
    Effect.gen(function* lookalikes() {
      for (const name of [
        "Bearer token-refresh-suite",
        "Basic authentication-for-everyone",
        "sk-learn-compatibility-tests",
        "task-runner-integration",
        "SHOP_CANARY_TOKEN",
        "--token-command",
        "docs/secret-rotation.md",
        "integration-tests-against-staging-database-replica",
        "0123456789abcdef0123456789abcdef01234567",
      ]) {
        expect(
          yield* pathsOf(set(json, ["observe", "checks", 0, "name"], name))
        ).toEqual([]);
      }
    })
  );

  it.effect(
    "rejects a credential in every string field and never echoes it",
    () =>
      Effect.gen(function* everyField() {
        expect(stringLeaves.length).toBeGreaterThan(40);

        for (const credential of credentials) {
          for (const { path } of stringLeaves) {
            const { message, paths } = yield* rejection(
              set(json, path, credential)
            );

            const owner = path.at(-1) === "_tag" ? path.slice(0, -1) : path;
            expect(paths).toEqual([dotted(owner)]);
            expect(message).not.toContain(credential);
          }

          const named = yield* rejection(
            set(json, ["observe", "canary", "secret", "name"], credential)
          );

          expect(named.paths).toEqual(["observe.canary.secret.name"]);
          expect(named.message).not.toContain(credential);
        }
      })
  );
});

describe("poll floor", () => {
  it.effect.prop(
    "accepts exactly the poll intervals core's train input accepts",
    {
      pollMs: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 200_000, minimum: 0 }))
      ),
    },
    ({ pollMs }) =>
      Effect.gen(function* pollFloor() {
        const accepted = yield* decodePiperConfig(
          set(json, ["mergeLine", "pollMs"], pollMs)
        ).pipe(Effect.isSuccess);

        expect(accepted).toBe(
          Schema.is(TrainInputSchema)({ ...input(1), pollMs })
        );
      }),
    { arbitrary: { runs: 400 } }
  );

  it.effect("names mergeLine.pollMs below ten seconds", () =>
    Effect.gen(function* belowFloor() {
      expect(yield* pathsOf(set(json, ["mergeLine", "pollMs"], 9999))).toEqual([
        "mergeLine.pollMs",
      ]);
      expect(
        yield* pathsOf(set(json, ["mergeLine", "pollMs"], 10_000))
      ).toEqual([]);
    })
  );
});

type Keys<A> = A extends Alarm ? keyof A : never;

describe("alarms", () => {
  it("have no refusing variant or field in their type", () => {
    expectTypeOf<Alarm["_tag"]>().toEqualTypeOf<
      "OutsideWindows" | "StartupCpuJump"
    >();
    expectTypeOf<Keys<Alarm>>().toEqualTypeOf<
      "_tag" | "ratio" | "timeZone" | "unit" | "windows"
    >();
  });

  it.effect("reject every attempt to make an alarm refuse a release", () =>
    Effect.gen(function* cannotRefuse() {
      const attempts = [
        [extend(json, ["alarms", 0], "refuse", true), "alarms.0.refuse"],
        [extend(json, ["alarms", 0], "onFail", "restore"), "alarms.0.onFail"],
        [extend(json, ["alarms", 1], "action", "hold"), "alarms.1.action"],
        [set(json, ["alarms", 0, "_tag"], "Refuse"), "alarms.0"],
        [set(json, ["alarms", 1, "_tag"], "HoldRelease"), "alarms.1"],
      ] as const;

      for (const [candidate, path] of attempts) {
        expect(yield* pathsOf(candidate)).toEqual([path]);
      }
    })
  );
});

describe("unknown keys", () => {
  it.effect("rejects an unknown key on every object and names it", () =>
    Effect.gen(function* unknownKeys() {
      const objects = nodes(json).filter((node) => isRecord(node.value));
      expect(objects.length).toBeGreaterThan(20);

      for (const { path } of objects) {
        expect(yield* pathsOf(extend(json, path, "unexpected", true))).toEqual([
          dotted([...path, "unexpected"]),
        ]);
      }
    })
  );
});

describe("deploy path and check scope globs", () => {
  const globs = [
    ["deploy", "paths", "rules", 0, "glob"],
    ["observe", "checks", 3, "scope", 0],
  ];

  it.effect("accept repository-relative **, * and {a,b} globs", () =>
    Effect.gen(function* accepted() {
      for (const glob of globs) {
        for (const candidate of [
          "**",
          "src/**",
          "**/*.md",
          ".github/**",
          "apps/*/src/**",
          "*.{test,spec}.*",
          "{skills/*/SKILL.md,prompts/*.md}",
          "{a,{b,c}}/**",
          "wrangler{.toml,}",
          "apps/web/app/(shop)/**",
        ]) {
          expect(yield* pathsOf(set(json, glob, candidate))).toEqual([]);
        }
      }
    })
  );

  it.effect("reject globs that would not mean what they say", () =>
    Effect.gen(function* rejected() {
      for (const candidate of [
        "/srv/app/**",
        "docs/",
        "docs//x.md",
        "./docs/**",
        "docs/../src/**",
        "{docs,..}/**",
        "src**",
        "**.md",
        "a/***/b",
        "{docs,src",
        "docs}/**",
        "{,docs}/**",
        "!docs/**",
        "src/?.ts",
        "src/[ab].ts",
        "src\\*.ts",
      ]) {
        for (const glob of globs) {
          expect(yield* pathsOf(set(json, glob, candidate))).toEqual([
            dotted(glob),
          ]);
        }
      }
    })
  );

  it.effect("reject an empty scope and name the fix", () =>
    Effect.gen(function* emptyScope() {
      const scope = ["observe", "checks", 3, "scope"];

      expect(yield* rejection(set(json, scope, []))).toEqual({
        message:
          "Piper configuration is invalid at observe.checks.3.scope. observe.checks.3.scope is empty, so the check would never be required; drop scope to require the check always",
        paths: ["observe.checks.3.scope"],
      });
    })
  );
});

describe("error messages", () => {
  it.effect("add each failed rule's own reason after the paths", () =>
    Effect.gen(function* reasons() {
      const candidate = set(
        set(
          set(json, ["units", 1, "name"], "storefront"),
          ["repo", "owner"],
          ""
        ),
        ["observe", "checks", 3, "scope"],
        []
      );

      expect((yield* rejection(candidate)).message).toBe(
        [
          "Piper configuration is invalid at observe.checks.3.scope, repo.owner, units.1.name",
          "observe.checks.3.scope is empty, so the check would never be required; drop scope to require the check always",
          "units.1.name repeats an earlier name",
        ].join(". ")
      );
      expect((yield* rejection(set(json, ["repo", "owner"], ""))).message).toBe(
        "Piper configuration is invalid at repo.owner"
      );
    })
  );
});

describe("guards", () => {
  it.effect("name the exact path of each refused setting", () =>
    Effect.gen(function* guards() {
      const cases = [
        [set(json, ["units", 1, "name"], "storefront"), "units.1.name"],
        [
          set(json, ["units", 1, "script"], "shop-storefront"),
          "units.1.script",
        ],
        [extend(json, ["units", 1], "primary", true), "units.1.primary"],
        [set(json, ["units", 1, "script"], "Shop API"), "units.1.script"],
        [set(json, ["alarms", 0, "unit"], "checkout"), "alarms.0.unit"],
        [set(json, ["alarms", 0, "ratio"], 1), "alarms.0.ratio"],
        [
          set(json, ["alarms", 1, "windows", 0, "end"], "09:00"),
          "alarms.1.windows.0.end",
        ],
        [set(json, ["alarms", 1, "timeZone"], "Eastern"), "alarms.1.timeZone"],
        [
          extend(json, ["mergeLine"], "labels", { hold: "train" }),
          "mergeLine.labels.hold",
        ],
        [set(json, ["mergeLine", "maxCars"], 13), "mergeLine.maxCars"],
        [set(json, ["mergeLine", "maxCars"], 0), "mergeLine.maxCars"],
        [
          extend(json, ["mergeLine"], "ciTimeoutMs", 59_999),
          "mergeLine.ciTimeoutMs",
        ],
        [set(json, ["mergeLine", "excluded", 0], 0), "mergeLine.excluded.0"],
        [
          set(json, ["mergeLine", "checks", "train", 0], []),
          "mergeLine.checks.train.0.0",
        ],
        [
          extend(json, ["observe"], "cadence", { maxMs: 10_000 }),
          "observe.cadence.minMs",
        ],
        [
          set(json, ["observe", "canary", "url"], "http://shop.example/canary"),
          "observe.canary.url",
        ],
        [
          set(json, ["observe", "checks", 1, "name"], "readback"),
          "observe.checks.1.name",
        ],
        [
          set(json, ["observe", "checks", 0, "onFail"], "refuse"),
          "observe.checks.0.onFail",
        ],
        [
          set(json, ["deploy", "paths", "rules", 0, "glob"], "/srv/app/**"),
          "deploy.paths.rules.0.glob",
        ],
        [
          set(json, ["deploy", "paths", "default"], "include"),
          "deploy.paths.default",
        ],
        [
          set(json, ["deploy", "migrations", 0], "../db"),
          "deploy.migrations.0",
        ],
        [set(json, ["repo", "owner"], "acme/shop"), "repo.owner"],
        [set(json, ["repo", "base"], "main..next"), "repo.base"],
        [set(json, ["units"], []), "units.0"],
      ] as const;

      for (const [candidate, path] of cases) {
        expect(yield* pathsOf(candidate)).toEqual([path]);
      }
    })
  );

  it.effect("names every bad path at once, sorted", () =>
    Effect.gen(function* allPaths() {
      const candidate = set(
        set(json, ["repo", "owner"], ""),
        ["mergeLine", "pollMs"],
        1
      );

      expect(yield* pathsOf(candidate)).toEqual([
        "mergeLine.pollMs",
        "repo.owner",
      ]);
      expect(yield* pathsOf(null)).toEqual(["the configuration root"]);
    })
  );
});
