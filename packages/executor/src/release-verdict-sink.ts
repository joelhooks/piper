import { Context } from "effect";
import type { Effect } from "effect";

import type { ExecutorError } from "./domain.js";
import type { VerdictRow } from "./release-run-domain.js";

export class VerdictSink extends Context.Service<
  VerdictSink,
  {
    readonly write: (row: VerdictRow) => Effect.Effect<void, ExecutorError>;
  }
>()("piper-executor/release/VerdictSink") {}
