import type {
  ReleaseExpectation,
  ReleaseInput,
  ReleaseRow,
  ReleaseViolation,
} from "./release-domain.js";

const matches = (
  row: ReleaseRow,
  matcher: ReleaseExpectation["allowed"][number]
) =>
  (matcher.id === undefined || row.id === matcher.id) &&
  (matcher.idPrefix === undefined || row.id.startsWith(matcher.idPrefix)) &&
  (matcher.kind === undefined || row.kind === matcher.kind) &&
  (matcher.action === undefined || row.action === matcher.action) &&
  Object.entries(matcher.attributes ?? {}).every(
    ([key, value]) => row.attributes?.[key] === value
  );

export const checkReleaseExpectation = (
  rows: readonly ReleaseRow[],
  expectation: ReleaseExpectation
): readonly ReleaseViolation[] => {
  const violations: ReleaseViolation[] = [];

  if (rows.length === 0 && expectation.allowEmpty !== true) {
    violations.push({ reason: "requiredMissing" });
  }

  for (const row of rows) {
    const stopped = expectation.stop.find((matcher) => matches(row, matcher));

    if (stopped !== undefined) {
      violations.push({ matcher: stopped, reason: "stop", row });
    } else if (!expectation.allowed.some((matcher) => matches(row, matcher))) {
      violations.push({ reason: "unmatched", row });
    }
  }

  for (const required of expectation.required ?? []) {
    const count = rows.filter((row) => matches(row, required.match)).length;

    if (count < (required.min ?? 1)) {
      violations.push({ matcher: required.match, reason: "requiredMissing" });
    } else if (required.max !== undefined && count > required.max) {
      violations.push({ matcher: required.match, reason: "countOutOfRange" });
    }
  }

  return violations;
};

export const releaseRunway = (
  input: Pick<
    ReleaseInput,
    "windowEndsAt" | "minimumRunwayMs" | "blackoutUntil"
  >,
  at: number
) =>
  at >= input.blackoutUntil && input.windowEndsAt - at >= input.minimumRunwayMs;
