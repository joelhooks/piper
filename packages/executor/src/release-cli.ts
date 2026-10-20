import { Config, Data, Effect, FileSystem, Layer, Predicate } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import type { ExecutorError } from "./domain.js";
import type { Admission, ReleaseRefusal } from "./release-run-domain.js";
import {
  liveFireSinks,
  releaseFileStore,
  releaseSinkLayer,
} from "./release-run-services.js";
import { decodeReleaseConfig, runRelease } from "./release-run.js";
import { releaseCommandsLayer } from "./release.js";

interface ReleaseCliOptions {
  readonly admission: Admission;
  readonly config: string;
  readonly mode: "dry-run" | "live";
  readonly state: string;
  readonly verdicts: string;
}

const refusals = Data.taggedEnum<ReleaseRefusal>();

const runtimeRefusal = (
  error: ExecutorError | ReleaseRefusal
): ReleaseRefusal => {
  if (!Predicate.isTagged(error, "ExecutorError")) {
    return error;
  }

  return error.code === "configuration"
    ? refusals.Configuration({
        harm: error.message,
        next: "Configure both MessageOwner and PageOwner before live fire.",
      })
    : refusals.Storage({
        harm: error.message,
        next: "Preserve the state directory and verdict file; reconcile the writer before retrying.",
      });
};

const executeReleaseCli = Effect.fn("CLI.release")(function* executeReleaseCli(
  action: "ready" | "fire",
  options: ReleaseCliOptions
) {
  const fs = yield* FileSystem.FileSystem;

  const text = yield* fs.readFileString(options.config).pipe(
    Effect.mapError(() =>
      refusals.Configuration({
        harm: "The release config file cannot be read.",
        next: "Provide a readable JSON release config before preparing or firing.",
      })
    )
  );

  const config = yield* decodeReleaseConfig(text);

  const admittedRepo = yield* Config.String("PIPER_LIVE_ADMITTED_REPO").pipe(
    Config.withDefault(""),
    Effect.mapError(() =>
      refusals.Admission({
        harm: "Repository admission cannot be read.",
        next: "Set PIPER_LIVE_ADMITTED_REPO to the exact configured repository after operator review.",
      })
    )
  );

  const sinks = releaseSinkLayer(action, options.mode, () =>
    liveFireSinks(config, options.verdicts).pipe(
      Layer.provide(releaseCommandsLayer)
    )
  );

  const result = yield* runRelease(config, {
    action,
    admission: options.admission,
    admittedRepo,
    mode: options.mode,
  }).pipe(
    Effect.provide(
      Layer.mergeAll(sinks, releaseCommandsLayer).pipe(
        Layer.provideMerge(releaseFileStore(options.state))
      )
    ),
    Effect.mapError(runtimeRefusal)
  );

  yield* Effect.log(JSON.stringify(result));
});

const ready = Command.make(
  "ready",
  {
    config: Argument.String("config"),
    state: Flag.String("state"),
  },
  (options) =>
    executeReleaseCli("ready", {
      ...options,
      admission: {
        by: "preflight",
        override: false,
        verdict: "hold",
        words: "Preparation only; no deployment admission.",
      },
      mode: "dry-run",
      verdicts: "",
    })
);

const fire = Command.make(
  "fire",
  {
    by: Flag.String("by"),
    config: Argument.String("config"),
    mode: Flag.Literals("mode", ["dry-run", "live"]).pipe(
      Flag.withDefault("dry-run")
    ),
    override: Flag.Boolean("override").pipe(Flag.withDefault(false)),
    state: Flag.String("state"),
    verdict: Flag.Literals("verdict", ["approve", "hold"]),
    verdicts: Flag.String("verdicts"),
    words: Flag.String("words"),
  },
  (options) =>
    executeReleaseCli("fire", {
      admission: {
        by: options.by,
        override: options.override,
        verdict: options.verdict,
        words: options.words,
      },
      config: options.config,
      mode: options.mode,
      state: options.state,
      verdicts: options.verdicts,
    })
);

export const releaseCli = Command.make("release").pipe(
  Command.withSubcommands([ready, fire])
);
