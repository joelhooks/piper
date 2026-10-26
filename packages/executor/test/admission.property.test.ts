import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { runAdmitted } from "../src/admission.js";
import type { Mode } from "../src/domain.js";

const modes: readonly Mode[] = ["live", "dry-run"];

it.effect.prop(
  "only an exact nonempty live admission constructs work; dry runs need no admission",
  {
    admitted: Arbitrary.schema(Schema.String),
    repo: Arbitrary.schema(Schema.String),
  },
  ({ admitted, repo }) =>
    Effect.gen(function* scenario() {
      for (const value of [undefined, "", repo, `${repo}λ`, admitted]) {
        for (const mode of modes) {
          let constructions = 0;

          const result = yield* runAdmitted(mode, repo, () => {
            constructions += 1;

            return Effect.succeed("built");
          }).pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown(
                value === undefined ? {} : { PIPER_LIVE_ADMITTED_REPO: value }
              )
            ),
            Effect.result
          );

          const allowed =
            mode === "dry-run" ||
            (value !== undefined && value.length > 0 && value === repo);

          expect(Result.isSuccess(result)).toBe(allowed);
          expect(constructions).toBe(allowed ? 1 : 0);
        }
      }
    })
);
