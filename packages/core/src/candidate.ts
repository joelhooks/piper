import { Data } from "effect";

export interface CandidateEvidence {
  readonly live: string;

  readonly main: string;

  readonly rangeFrom: string;

  readonly changedPaths: readonly string[];

  readonly migrationDirs: readonly string[];

  readonly bundleChanged: boolean | undefined;

  readonly codeOnly: "pass" | "fail" | undefined;
}

interface Range {
  readonly live: string;
  readonly main: string;
}

interface Guarded extends Range {
  readonly harm: string;
  readonly next: string;
}

export type CandidateDecision = Data.TaggedEnum<{
  Candidate: Range;
  DeskFire: Guarded;
  NoChange: Range;
  SchemaFirst: Guarded & { readonly migrations: readonly string[] };
  Unchanged: Range;
  Unknown: Guarded;
}>;

export const decisions = Data.taggedEnum<CandidateDecision>();

const migrationsIn = (
  paths: readonly string[],
  directories: readonly string[]
) =>
  paths
    .filter((path) =>
      path.split("/").some((segment) => directories.includes(segment))
    )
    .toSorted();

const evidenceGap = (evidence: CandidateEvidence) => {
  if (evidence.codeOnly === undefined) {
    return "run the read-only plan and its code-only check for this range";
  }

  return evidence.codeOnly === "pass" && evidence.bundleChanged === undefined
    ? "supply the bundle-change verdict for this range"
    : undefined;
};

export const decideCandidate = (
  evidence: CandidateEvidence
): CandidateDecision => {
  const range = { live: evidence.live, main: evidence.main };

  if (evidence.main === evidence.live) {
    return decisions.Unchanged(range);
  }

  if (evidence.rangeFrom !== evidence.live) {
    return decisions.Unknown({
      ...range,
      harm: "skipping a change that landed after the live release",
      next: `recompute the evidence from the live release ${evidence.live}`,
    });
  }

  const migrations = migrationsIn(
    evidence.changedPaths,
    evidence.migrationDirs
  );

  if (migrations.length > 0) {
    return decisions.SchemaFirst({
      ...range,
      harm: "deploying code that reads a schema production may not have",
      migrations,
      next: "apply and read back the schema change, then the operator fires this release",
    });
  }

  const gap = evidenceGap(evidence);

  if (gap !== undefined) {
    return decisions.Unknown({
      ...range,
      harm: "acting on missing release evidence",
      next: gap,
    });
  }

  if (evidence.codeOnly === "fail") {
    return decisions.DeskFire({
      ...range,
      harm: "firing a release with more than code changes unattended",
      next: "the operator reviews the plan and fires this release",
    });
  }

  return evidence.bundleChanged === true
    ? decisions.Candidate(range)
    : decisions.NoChange(range);
};
