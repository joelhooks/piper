import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { PathRulesSchema } from "../src/config.js";
import type { PathRules } from "../src/config.js";
import { deployable, PathDecisionSchema } from "../src/deploy-paths.js";
import type { PathDecision } from "../src/deploy-paths.js";

const joined = (pieces: Arbitrary.Arbitrary<string>) =>
  Arbitrary.array(pieces, { maxLength: 4, minLength: 1 }).pipe(
    Arbitrary.map((parts) => parts.join("/"))
  );

const changedPaths = Arbitrary.array(
  joined(
    Arbitrary.schema(
      Schema.Literals([
        "a",
        "b",
        "ab",
        ".x",
        "(g)",
        "a.md",
        "b.test.ts",
        "tests",
        "SKILL.md",
      ])
    )
  ),
  { maxLength: 6 }
);

const glob = joined(
  Arbitrary.schema(
    Schema.Literals([
      "a",
      "b",
      ".x",
      "(g)",
      "tests",
      "*",
      "**",
      "a*",
      "*b*",
      "*.md",
      "*.test.*",
      "a{.md,}",
      "{a,b}",
      "{a,{b,*}}",
      "{a/b,tests}",
      "{**/a,b}",
    ])
  )
);

const scenarios = Arbitrary.all({
  changed: changedPaths,
  fallback: Arbitrary.schema(Schema.Literals(["deploy", "skip"])),
  rules: Arbitrary.array(
    Arbitrary.all({ deploy: Arbitrary.schema(Schema.Boolean), glob }),
    { maxLength: 6 }
  ),
});

const decodeRules = Schema.decodeSync(PathRulesSchema);

const innermostBraces = /\{(?<body>[^{}]*)\}/u;

const expandBraces = (text: string): readonly string[] => {
  const found = innermostBraces.exec(text);

  if (found === null) {
    return [text];
  }

  const before = text.slice(0, found.index);
  const after = text.slice(found.index + found[0].length);

  return (found.groups?.body ?? "")
    .split(",")
    .flatMap((alternative) => expandBraces(`${before}${alternative}${after}`));
};

const escapeRegExp = (text: string) =>
  text.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

const segmentPattern = (segment: string) =>
  segment === "**"
    ? "(?:/[^/]*)*"
    : `/${segment.split("*").map(escapeRegExp).join("[^/]*")}`;

const oracleMatches = (text: string, path: string) =>
  expandBraces(text).some((alternative) =>
    new RegExp(
      `^${alternative.split("/").map(segmentPattern).join("")}$`,
      "u"
    ).test(`/${path}`)
  );

const firstMatchWins = (
  { default: fallback, rules }: PathRules,
  path: string
) => {
  let decision: PathDecision = PathDecisionSchema.cases.Default.make({
    deploy: fallback === "deploy",
    path,
  });

  for (const [index, rule] of [...rules.entries()].toReversed()) {
    if (oracleMatches(rule.glob, path)) {
      decision = PathDecisionSchema.cases.Rule.make({ ...rule, index, path });
    }
  }

  return decision;
};

const matchedVerdicts = (rules: PathRules["rules"], path: string) =>
  new Set(
    rules.flatMap((rule) =>
      oracleMatches(rule.glob, path) ? [rule.deploy] : []
    )
  ).size;

describe("deployable", () => {
  it.prop(
    "agrees with a first-match-wins reference for any rules and paths",
    { scenario: scenarios },
    ({ scenario: { changed, fallback, rules } }) => {
      const pathRules = decodeRules({ default: fallback, rules });
      const decisions = changed.map((path) => firstMatchWins(pathRules, path));

      expect(deployable(pathRules, changed)).toEqual({
        decisions,
        deploy: decisions.some(({ deploy }) => deploy),
      });
    },
    { arbitrary: { runs: 1000 } }
  );

  it.effect("the generator reaches unmatched, agreed and contested paths", () =>
    Effect.gen(function* reach() {
      const samples = yield* Arbitrary.sampleEffect(scenarios, {
        count: 300,
        seed: 17,
      }).pipe(Effect.orDie);

      const reached = new Set(
        samples.flatMap(({ changed, rules }) =>
          changed.map((path) => matchedVerdicts(rules, path))
        )
      );

      expect([...reached].toSorted((left, right) => left - right)).toEqual([
        0, 1, 2,
      ]);
    })
  );
});
