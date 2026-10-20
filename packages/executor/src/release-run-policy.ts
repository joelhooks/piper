import type {
  ReleaseExpectation,
  ReleaseRow,
} from "@joelhooks/piper/release-domain";
import { checkReleaseExpectation } from "@joelhooks/piper/release-policy";
import { Predicate } from "effect";

import type { RunLogLine } from "./release-run-domain.js";

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
