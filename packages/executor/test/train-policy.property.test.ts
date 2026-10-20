import { expect, it } from "@effect/vitest";
import type { CheckRun } from "@joelhooks/piper/domain";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { rerunRefusal } from "../src/train-policy.js";
import { admission } from "./train-fixture.js";

const conclusions = Arbitrary.array(
  Arbitrary.schema(Schema.Literals(["cancelled", "startup_failure", "stale"])),
  { maxLength: 12, minLength: 1 }
);

it.prop(
  "every nonempty environment-only red permits one rerun, any real red refuses it",
  [conclusions],
  ([values]) => {
    const checks = values.map(
      (conclusion) =>
        ({
          conclusion,
          headSha: "built-a",
          name: "unit",
          status: "completed",
        }) satisfies CheckRun
    );

    expect(rerunRefusal(checks, admission, "built-a")).toBeUndefined();

    const unsafe = [
      ...checks,
      {
        conclusion: "failure",
        headSha: "built-a",
        name: "real-red",
        status: "completed",
      } satisfies CheckRun,
    ];

    const refusal = rerunRefusal(unsafe, admission, "built-a");
    expect(refusal?.harm).toBe("rerunning a real failure instead of fixing it");
    expect(refusal?.next).toBe(
      "fix the red; rerun only a finished environment-only failure"
    );
  }
);
