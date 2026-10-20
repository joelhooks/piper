import type {
  ReleaseExpectation,
  ReleaseRow,
} from "@joelhooks/piper/release-domain";
import { checkReleaseExpectation } from "@joelhooks/piper/release-policy";
import { Data, Predicate } from "effect";
import type { Schema } from "effect";

import type { ReleaseRefusal, RunLogLine } from "./release-run-domain.js";
import { schemaIssuePaths } from "./schema-paths.js";

const refusals = Data.taggedEnum<ReleaseRefusal>();

const namedPaths = (cause: Schema.SchemaError, root: string) =>
  schemaIssuePaths(cause)
    .map((path) => (path === "" ? root : path))
    .join(", ");

export const releaseConfigRefusal = (
  cause: Schema.SchemaError
): ReleaseRefusal => {
  const paths = namedPaths(cause, "the configuration root");

  return refusals.Configuration({
    harm: `Release configuration is invalid at ${paths}.`,
    next: `Correct ${paths} against ReleaseConfigSchema before preparing or firing.`,
  });
};

export const releaseAdmissionRefusal = (
  cause: Schema.SchemaError
): ReleaseRefusal => {
  const paths = namedPaths(cause, "the admission root");

  return refusals.Admission({
    harm: `Operator admission is invalid at ${paths}.`,
    next: `Correct ${paths}; supply the operator's by and words with approve or hold and an explicit override decision.`,
  });
};

export const codeOnlyPlan = (
  rows: readonly ReleaseRow[],
  expectation: ReleaseExpectation
) =>
  checkReleaseExpectation(rows, expectation).length === 0 &&
  rows.every(
    (row) =>
      row.kind === "computed" ||
      row.kind === "deferred" ||
      (row.kind === "resource" &&
        (row.action === "update" || row.action === "noop"))
  );

export const attemptedDeploy = (lines: readonly RunLogLine[], sha: string) =>
  lines.some(
    (line) =>
      Predicate.isTagged(line, "intent") &&
      line.intent.kind === "Deploy" &&
      line.intent.target === sha
  );
