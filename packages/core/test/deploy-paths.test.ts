import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { PathRulesSchema } from "../src/config.js";
import type { PathRules } from "../src/config.js";
import { deployable, PathDecisionSchema } from "../src/deploy-paths.js";
import { matchesGlob } from "../src/glob.js";

const bundledDocs = { deploy: true, glob: "{AGENTS,VISION}.md" };

const bundledPrompts = {
  deploy: true,
  glob: "{skills/*/SKILL.md,prompts/*.md}",
};

const generators = {
  deploy: true,
  glob: "scripts/{build-catalog,render-prompts}.ts",
};

const manifests = {
  deploy: true,
  glob: "**/{package.json,pnpm-lock.yaml,turbo.json}",
};

const inertDirectories = {
  deploy: false,
  glob: "{.notes,docs,skills,scripts,.github,.changeset,.agent,backlog}/**",
};

const toolApps = { deploy: false, glob: "apps/{tool,console}/**" };

const testDirectories = {
  deploy: false,
  glob: "**/{test,tests,__tests__,fixtures}/**",
};

const testFiles = { deploy: false, glob: "**/*.{test,spec}.*" };

const prose = { deploy: false, glob: "**/*.{md,svx,txt}" };

const conventionFiles = {
  deploy: false,
  glob: "**/{README,CHANGELOG,AGENTS,CLAUDE,NOTES}{,.*}",
};

const threePartRule: PathRules = Schema.decodeSync(PathRulesSchema)({
  rules: [
    bundledDocs,
    bundledPrompts,
    generators,
    manifests,
    inertDirectories,
    toolApps,
    testDirectories,
    testFiles,
    prose,
    conventionFiles,
  ],
});

const byDefault = "default";

type Decider = typeof bundledDocs | typeof byDefault;

const table: readonly (readonly [string, Decider])[] = [
  ["AGENTS.md", bundledDocs],
  ["VISION.md", bundledDocs],
  ["skills/search/SKILL.md", bundledPrompts],
  ["skills/review/SKILL.md", bundledPrompts],
  ["prompts/triage.md", bundledPrompts],
  ["scripts/build-catalog.ts", generators],
  ["scripts/render-prompts.ts", generators],
  ["package.json", manifests],
  ["apps/web/package.json", manifests],
  ["pnpm-lock.yaml", manifests],
  ["turbo.json", manifests],
  ["packages/ui/turbo.json", manifests],
  ["docs/package.json", manifests],
  ["apps/tool/package.json", manifests],
  ["tests/fixtures/package.json", manifests],
  ["skills/search/notes.md", inertDirectories],
  ["skills/search/examples/query.json", inertDirectories],
  ["scripts/cleanup.sh", inertDirectories],
  ["scripts/build-catalog.test.ts", inertDirectories],
  ["docs/guide/setup.md", inertDirectories],
  [".notes/projects/plan.svx", inertDirectories],
  [".github/workflows/ci.yml", inertDirectories],
  [".github/workflows/release.yml", inertDirectories],
  [".changeset/brave-owls.md", inertDirectories],
  [".agent/settings.json", inertDirectories],
  ["backlog/tasks.txt", inertDirectories],
  ["apps/tool/src/main.ts", toolApps],
  ["apps/console/index.html", toolApps],
  ["apps/web/src/tests/cart.ts", testDirectories],
  ["packages/api/test/setup.ts", testDirectories],
  ["apps/web/src/__tests__/checkout.tsx", testDirectories],
  ["packages/db/fixtures/seed.sql", testDirectories],
  ["tests/e2e/smoke.ts", testDirectories],
  ["apps/web/src/cart.test.ts", testFiles],
  ["packages/api/src/routes.spec.tsx", testFiles],
  ["prompts/drafts/old.md", prose],
  ["apps/web/AGENTS.md", prose],
  ["apps/web/README.md", prose],
  ["apps/web/src/copy.txt", prose],
  ["README", conventionFiles],
  ["packages/ui/CHANGELOG", conventionFiles],
  ["packages/ui/README.rst", conventionFiles],
  ["packages/api/NOTES.html", conventionFiles],
  ["src/main.ts", byDefault],
  ["apps/web/src/index.ts", byDefault],
  ["packages/api/src/routes.ts", byDefault],
  ["wrangler.toml", byDefault],
  ["Dockerfile", byDefault],
  [".nvmrc", byDefault],
  ["migrations/0001_init.sql", byDefault],
  ["apps/web/public/logo.svg", byDefault],
  ["apps/toolbox/src/main.ts", byDefault],
  ["packages/testing/src/index.ts", byDefault],
  ["apps/web/src/contest.ts", byDefault],
];

const changed = table.map(([path]) => path);

const expected = table.map(([path, decider]) =>
  decider === byDefault
    ? PathDecisionSchema.cases.Default.make({ deploy: true, path })
    : PathDecisionSchema.cases.Rule.make({
        deploy: decider.deploy,
        glob: decider.glob,
        index: threePartRule.rules.findIndex(
          ({ glob }) => glob === decider.glob
        ),
        path,
      })
);

const disagreements = (rules: PathRules) =>
  deployable(rules, changed).decisions.flatMap(({ deploy, path }, index) =>
    deploy === expected[index]?.deploy ? [] : [path]
  );

describe("the three-part deploy rule", () => {
  it("decides every table row by the rule the table names", () => {
    expect(table.length).toBeGreaterThanOrEqual(40);
    expect(deployable(threePartRule, changed).decisions).toEqual(expected);
  });

  it("deploys a change set when any path deploys", () => {
    const inert = [
      "docs/guide/setup.md",
      ".github/workflows/ci.yml",
      "apps/web/src/tests/cart.ts",
    ];

    expect(deployable(threePartRule, []).deploy).toBe(false);
    expect(deployable(threePartRule, inert).deploy).toBe(false);
    expect(
      deployable(threePartRule, [...inert, "skills/search/SKILL.md"]).deploy
    ).toBe(true);
    expect(deployable(threePartRule, [...inert, "Dockerfile"]).deploy).toBe(
      true
    );
  });

  it("depends on rule order and on the deploy default", () => {
    expect(
      disagreements({
        ...threePartRule,
        rules: threePartRule.rules.toReversed(),
      })
    ).toEqual([
      "AGENTS.md",
      "VISION.md",
      "skills/search/SKILL.md",
      "skills/review/SKILL.md",
      "prompts/triage.md",
      "scripts/build-catalog.ts",
      "scripts/render-prompts.ts",
      "docs/package.json",
      "apps/tool/package.json",
      "tests/fixtures/package.json",
    ]);
    expect(disagreements({ ...threePartRule, default: "skip" })).toEqual(
      table.flatMap(([path, decider]) => (decider === byDefault ? [path] : []))
    );
  });
});

describe("glob", () => {
  const cases: readonly (readonly [string, string, boolean])[] = [
    ["src/*.ts", "src/main.ts", true],
    ["src/*.ts", "src/lib/main.ts", false],
    ["src/**", "src/lib/deep/main.ts", true],
    ["docs/**", "docs", true],
    ["**/main.ts", "main.ts", true],
    ["**/tests/**", "tests/a.ts", true],
    ["**/tests/**", "apps/x/src/tests/a.ts", true],
    ["**/tests/**", "apps/x/src/contests/a.ts", false],
    ["*", ".nvmrc", true],
    ["*", "src/main.ts", false],
    ["**/*.yml", ".github/workflows/ci.yml", true],
    ["*.{test,spec}.*", "cart.spec.tsx", true],
    ["*.{test,spec}.*", "cart.ts", false],
    ["{skills/*/SKILL.md,prompts/*.md}", "skills/x/SKILL.md", true],
    ["{skills/*/SKILL.md,prompts/*.md}", "skills/x/notes.md", false],
    ["{a,{b,c}}/x", "c/x", true],
    ["wrangler{.toml,}", "wrangler", true],
    ["wrangler{.toml,}", "wrangler.toml", true],
    ["apps/web/app/(shop)/**", "apps/web/app/(shop)/page.tsx", true],
    ["README{,.*}", "readme.md", false],
    ["a*b*c", "abc", true],
    ["a*b*c", "acb", false],
  ];

  it("matches **, * and {a,b} over repository paths", () => {
    expect(
      cases.map(([glob, path]) => [glob, path, matchesGlob(glob, path)])
    ).toEqual(cases);
  });
});
