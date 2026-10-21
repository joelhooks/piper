import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  AcceptanceSchema,
  accepted,
  ChangedPathsSchema,
  CheckStandingSchema,
  checkRequired,
} from "../src/accept.js";
import type { Verdict } from "../src/accept.js";
import { ObserveCheckSchema } from "../src/config.js";
import type { PiperConfig } from "../src/config.js";

const decodeCheck = Schema.decodeSync(ObserveCheckSchema);

const readback = decodeCheck({ name: "readback", onFail: "restore" });

const jobsScope = "{jobs,scheduler}/**";

const jobs = decodeCheck({
  name: "jobs",
  onFail: "escalate",
  scope: [jobsScope],
});

const checks: PiperConfig["observe"]["checks"] = [readback, jobs];

const known = (...paths: readonly string[]) =>
  ChangedPathsSchema.cases.Known.make({ paths });

const unread = ChangedPathsSchema.cases.Unread.make({});

const pass = (check: string): Verdict => ({ check, note: "", outcome: "PASS" });

const fail = (check: string, note: string): Verdict => ({
  check,
  note,
  outcome: "FAIL",
});

const override = (check: string, note: string): Verdict => ({
  check,
  note,
  outcome: "OVERRIDE",
});

const { Accepted, Refused, Waiting } = AcceptanceSchema.cases;

const { Failed, NotRequired, Overridden, Passed, Pending } =
  CheckStandingSchema.cases;

describe("checkRequired", () => {
  it("requires an unscoped check for any diff", () => {
    for (const changed of [known(), known("src/main.ts"), unread]) {
      expect(checkRequired(readback, changed)).toEqual({
        matched: [],
        required: true,
      });
    }
  });

  it("requires a scoped check only when a changed path matches its scope", () => {
    expect(checkRequired(jobs, known("src/main.ts", "docs/jobs.md"))).toEqual({
      matched: [],
      required: false,
    });
    expect(checkRequired(jobs, known())).toEqual({
      matched: [],
      required: false,
    });
    expect(
      checkRequired(
        jobs,
        known("src/main.ts", "jobs/send.ts", "scheduler/cron/daily.ts")
      )
    ).toEqual({
      matched: [
        { glob: jobsScope, path: "jobs/send.ts" },
        { glob: jobsScope, path: "scheduler/cron/daily.ts" },
      ],
      required: true,
    });
  });

  it("names every scope glob that matched each path", () => {
    const layered = decodeCheck({
      name: "jobs",
      onFail: "alarm",
      scope: ["jobs/**", "**/*.ts", "docs/**"],
    });

    expect(checkRequired(layered, known("jobs/send.ts", "README.md"))).toEqual({
      matched: [
        { glob: "jobs/**", path: "jobs/send.ts" },
        { glob: "**/*.ts", path: "jobs/send.ts" },
      ],
      required: true,
    });
  });

  it("requires a scoped check when the diff could not be read", () => {
    expect(checkRequired(jobs, unread)).toEqual({
      matched: [],
      required: true,
    });
  });
});

describe("accepted", () => {
  it("waits on an unscoped check with no verdict", () => {
    expect(accepted(checks, [pass("jobs")], known("src/main.ts"))).toEqual(
      Waiting.make({
        waiting: [Pending.make({ check: "readback", matched: [] })],
      })
    );
  });

  it("accepts without a scoped check whose scope the diff misses", () => {
    expect(accepted(checks, [pass("readback")], known("src/main.ts"))).toEqual(
      Accepted.make({
        reasons: [
          Passed.make({ check: "readback", matched: [] }),
          NotRequired.make({ check: "jobs" }),
        ],
      })
    );
  });

  it("waits on a scoped check whose scope the diff matches", () => {
    expect(
      accepted(checks, [pass("readback")], known("src/main.ts", "jobs/send.ts"))
    ).toEqual(
      Waiting.make({
        waiting: [
          Pending.make({
            check: "jobs",
            matched: [{ glob: jobsScope, path: "jobs/send.ts" }],
          }),
        ],
      })
    );
  });

  it("waits on a scoped check when the diff could not be read", () => {
    expect(accepted(checks, [pass("readback")], unread)).toEqual(
      Waiting.make({ waiting: [Pending.make({ check: "jobs", matched: [] })] })
    );
  });

  it("does not count an override whose note says Piper wrote it", () => {
    const changed = known("src/main.ts");

    for (const note of ["piper: auto retry", "piper:"]) {
      expect(accepted(checks, [override("readback", note)], changed)).toEqual(
        Waiting.make({
          waiting: [Pending.make({ check: "readback", matched: [] })],
        })
      );
    }

    expect(
      accepted(checks, [override("readback", "owner approved")], changed)
    ).toEqual(
      Accepted.make({
        reasons: [
          Overridden.make({
            check: "readback",
            matched: [],
            note: "owner approved",
          }),
          NotRequired.make({ check: "jobs" }),
        ],
      })
    );
  });

  it("does not count an alarm as a pass", () => {
    expect(
      accepted(
        checks,
        [{ check: "readback", note: "slow", outcome: "ALARM" }],
        known("src/main.ts")
      )
    ).toEqual(
      Waiting.make({
        waiting: [Pending.make({ check: "readback", matched: [] })],
      })
    );
  });

  it("ignores a failure on a scoped-out check", () => {
    expect(
      accepted(
        checks,
        [pass("readback"), fail("jobs", "queue stalled")],
        known("src/main.ts")
      )
    ).toEqual(
      Accepted.make({
        reasons: [
          Passed.make({ check: "readback", matched: [] }),
          NotRequired.make({ check: "jobs" }),
        ],
      })
    );
  });

  it("refuses on a failure of a required check", () => {
    expect(
      accepted(
        checks,
        [fail("readback", "served the old build"), pass("jobs")],
        known("jobs/send.ts")
      )
    ).toEqual(
      Refused.make({
        failed: [
          Failed.make({
            check: "readback",
            matched: [],
            notes: ["served the old build"],
          }),
        ],
      })
    );
  });

  it("lets a human override settle a failed check", () => {
    expect(
      accepted(
        checks,
        [
          fail("readback", "served the old build"),
          override("readback", "owner: cache purge pending"),
        ],
        known("src/main.ts")
      )
    ).toEqual(
      Accepted.make({
        reasons: [
          Overridden.make({
            check: "readback",
            matched: [],
            note: "owner: cache purge pending",
          }),
          NotRequired.make({ check: "jobs" }),
        ],
      })
    );
  });
});
