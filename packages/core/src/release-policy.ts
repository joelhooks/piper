import type {
  ReleaseExpectation,
  ReleaseInput,
  ReleaseRow,
} from "./release-domain.js";

const matches = (
  row: ReleaseRow,
  matcher: ReleaseExpectation["allowed"][number]
) =>
  (matcher.id === undefined || row.id === matcher.id) &&
  (matcher.idPrefix === undefined || row.id.startsWith(matcher.idPrefix)) &&
  (matcher.kind === undefined || row.kind === matcher.kind) &&
  (matcher.action === undefined || row.action === matcher.action);

export const checkReleaseExpectation = (
  rows: readonly ReleaseRow[],
  expectation: ReleaseExpectation
) =>
  rows.filter(
    (row) =>
      expectation.stop.some((matcher) => matches(row, matcher)) ||
      !expectation.allowed.some((matcher) => matches(row, matcher))
  );

export const releaseRunway = (
  input: Pick<
    ReleaseInput,
    "windowEndsAt" | "minimumRunwayMs" | "blackoutUntil"
  >,
  at: number
) =>
  at >= input.blackoutUntil && input.windowEndsAt - at >= input.minimumRunwayMs;
