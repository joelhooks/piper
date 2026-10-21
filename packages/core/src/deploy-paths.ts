import { Schema } from "effect";

import type { PathRules } from "./config.js";
import { matchesGlob } from "./glob.js";

export const PathDecisionSchema = Schema.TaggedUnion({
  Default: { deploy: Schema.Boolean, path: Schema.String },
  Rule: {
    deploy: Schema.Boolean,
    glob: Schema.String,
    index: Schema.Int,
    path: Schema.String,
  },
});

export type PathDecision = typeof PathDecisionSchema.Type;

export interface DeployVerdict {
  readonly decisions: readonly PathDecision[];
  readonly deploy: boolean;
}

const decidePath = (
  { default: fallback, rules }: PathRules,
  path: string
): PathDecision => {
  const index = rules.findIndex(({ glob }) => matchesGlob(glob, path));
  const rule = rules[index];

  return rule === undefined
    ? PathDecisionSchema.cases.Default.make({
        deploy: fallback === "deploy",
        path,
      })
    : PathDecisionSchema.cases.Rule.make({
        deploy: rule.deploy,
        glob: rule.glob,
        index,
        path,
      });
};

export const deployable = (
  pathRules: PathRules,
  changedPaths: readonly string[]
): DeployVerdict => {
  const decisions = changedPaths.map((path) => decidePath(pathRules, path));

  return { decisions, deploy: decisions.some(({ deploy }) => deploy) };
};
