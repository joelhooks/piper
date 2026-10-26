import { expect, it } from "@effect/vitest";
import type { ReleaseExpectation } from "@joelhooks/piper/release-domain";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { codeOnlyPlan } from "../src/release-run-policy.js";

const rows = Arbitrary.array(
  Arbitrary.schema(
    Schema.Struct({
      action: Schema.Literals([
        "update",
        "noop",
        "create",
        "delete",
        "replace",
      ]),
      id: Schema.NonEmptyString,
      kind: Schema.Literals(["resource", "computed", "deferred", "unknown"]),
    })
  ),
  { maxLength: 30 }
);

it.prop(
  "code-only admission permits only non-destructive resource actions and informational rows",
  { plan: rows },
  ({ plan }) => {
    const informational = plan.filter((row) =>
      ["computed", "deferred"].includes(row.kind)
    );

    const updates = plan.filter(
      (row) =>
        row.kind === "resource" && ["update", "noop"].includes(row.action)
    );

    const expectation: ReleaseExpectation = {
      allowEmpty: true,
      allowed: [{}],
      stop: [],
    };

    expect(codeOnlyPlan(plan, expectation)).toBe(
      informational.length + updates.length === plan.length
    );
    expect(codeOnlyPlan([...informational, ...updates], expectation)).toBe(
      true
    );
    expect(codeOnlyPlan(plan, { ...expectation, stop: [{}] })).toBe(
      plan.length === 0
    );
    expect(codeOnlyPlan(plan, { ...expectation, allowed: [] })).toBe(
      plan.length === 0
    );
    expect(codeOnlyPlan([], { ...expectation, allowEmpty: false })).toBe(false);
    expect(
      codeOnlyPlan(plan, {
        ...expectation,
        required: [{ match: {}, min: plan.length + 1 }],
      })
    ).toBe(false);
  }
);
