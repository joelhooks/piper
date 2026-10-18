import { Config, Effect } from "effect";

import { ExecutorError } from "./domain.js";
import type { Mode } from "./domain.js";

export const runAdmitted = Effect.fn("Executor.admission")(
  function* runAdmitted<A, E, R>(
    mode: Mode,
    repo: string,
    build: () => Effect.Effect<A, E, R>
  ) {
    if (mode === "live") {
      const admitted = yield* Config.String("PIPER_LIVE_ADMITTED_REPO").pipe(
        Config.withDefault(""),
        Effect.mapError(
          () =>
            new ExecutorError({
              code: "configuration",
              message: "Live admission could not be read",
            })
        )
      );

      if (admitted === "" || admitted !== repo) {
        return yield* new ExecutorError({
          code: "configuration",
          message:
            "Live mode requires PIPER_LIVE_ADMITTED_REPO to equal --repo exactly",
        });
      }
    }

    return yield* Effect.suspend(build);
  }
);
