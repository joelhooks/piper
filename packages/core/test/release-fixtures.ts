import type { ReleaseEvent, ReleaseInput } from "../src/release-domain.js";

export const releaseInput = {
  allowAbsentReview: false,
  at: 100,
  blackoutUntil: 0,
  checks: [
    { name: "availability", onFail: "restore" },
    { name: "integrity", onFail: "restore" },
  ],
  docs: { diff: "synthetic diff", spec: "synthetic spec" },
  expectation: {
    allowed: [
      { action: "update", kind: "resource" },
      { kind: "computed" },
      { kind: "deferred" },
    ],
    stop: [{ action: "delete" }],
  },
  minimumRunwayMs: 100,
  observationTimeoutMs: 100,
  previousTarget: "commit-before",
  runId: "release-synthetic",
  target: "commit-next",
  windowEndsAt: 10_000,
} satisfies ReleaseInput;

export const releaseHappy: readonly ReleaseEvent[] = [
  {
    at: 101,
    rows: [{ action: "update", id: "resource-a", kind: "resource" }],
    type: "planned",
  },
  { at: 102, by: "reviewer", type: "reviewed", verdict: "approve" },
  { at: 103, by: "operator", type: "fire" },
  { at: 104, type: "deployed" },
  { at: 105, check: "availability", outcome: "pass", type: "observed" },
  { at: 106, check: "integrity", outcome: "pass", type: "observed" },
];
