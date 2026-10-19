import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/cli";

import { command } from "./command.js";

NodeRuntime.runMain(
  command.pipe(
    Command.run({ version: "0.2.0" }),
    Effect.provide(NodeServices.layer)
  )
);
