import { Context, Data } from "effect";
import type { Effect } from "effect";

import type { ExecutorError } from "./domain.js";
import type { RunLogLine } from "./release-run-domain.js";

export const runLines = Data.taggedEnum<RunLogLine>();

export class RunLog extends Context.Service<
  RunLog,
  {
    readonly append: (line: RunLogLine) => Effect.Effect<void, ExecutorError>;
    readonly lines: Effect.Effect<readonly RunLogLine[], ExecutorError>;
  }
>()("piper-executor/release/RunLog") {}
