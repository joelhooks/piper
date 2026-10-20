import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { decodeConfig } from "./config.js";
import { CheckNames } from "./domain.js";
import { observe, render } from "./observe.js";

export const command = Command.make(
  "piper-observe",
  {
    baseline: Flag.Boolean("baseline").pipe(Flag.withDefault(false)),
    check: Flag.Literals("check", CheckNames),
    config: Flag.FileText("config"),
  },
  Effect.fn("Observe.cli")(function* cli(options) {
    const config = yield* decodeConfig(options.config);

    const observation = yield* observe(
      config,
      options.check,
      options.baseline ? "baseline" : "release"
    );

    yield* Console.log(render(observation));
  })
);
