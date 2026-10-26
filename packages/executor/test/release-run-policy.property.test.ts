import { expect, it } from "@effect/vitest";
import {
  DeploymentStateSchema,
  ReleaseFactSchema,
} from "@joelhooks/piper/release-domain";
import type {
  ReleaseExpectation,
  ReleaseFact,
} from "@joelhooks/piper/release-domain";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { codeOnlyPlan, releaseNote } from "../src/release-run-policy.js";

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

it.prop(
  "release notes speak only for a failed build or an observed successor, naming what they saw",
  {
    by: Arbitrary.schema(Schema.NonEmptyString),
    cause: Arbitrary.schema(Schema.NonEmptyString),
    check: Arbitrary.schema(Schema.NonEmptyString),
    deploymentId: Arbitrary.schema(Schema.NonEmptyString),
    deploymentState: Arbitrary.schema(DeploymentStateSchema),
    fact: Arbitrary.schema(ReleaseFactSchema),
  },
  ({ by, cause, check, deploymentId, deploymentState, fact }) => {
    const failed = releaseNote({
      at: 0,
      cause,
      check,
      deploymentId,
      deploymentState,
      kind: "buildFailed",
      state: "escalated",
    });

    expect(failed).toContain(`Build ${deploymentId} `);
    expect(failed).toContain(` ended ${deploymentState} `);
    expect(failed).toContain("never promoted");
    expect(failed).toContain("production is unchanged");

    const successor = (successorCause: string): ReleaseFact => ({
      at: 0,
      by,
      cause: successorCause,
      evidence: deploymentId,
      kind: "superseded",
      state: "superseded",
    });

    const replaced = releaseNote(successor("observationSuperseded"));

    expect(replaced).toContain(`Commit ${by.slice(0, 8)} `);
    expect(replaced).toContain(`deployment ${deploymentId} `);
    expect(replaced).toContain("nothing to restore");
    expect(
      releaseNote(
        successor(cause === "observationSuperseded" ? "superseded" : cause)
      )
    ).toBe("");

    const speaks =
      "kind" in fact &&
      (fact.kind === "buildFailed" ||
        (fact.kind === "superseded" && fact.cause === "observationSuperseded"));

    expect(releaseNote(fact) !== "").toBe(speaks);
  }
);
