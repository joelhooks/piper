import { Context } from "effect";
import type { Effect } from "effect";

import type { ExecutorError } from "./domain.js";
import type { Ready } from "./release-run-domain.js";

export class ReadyStore extends Context.Service<
  ReadyStore,
  {
    readonly read: Effect.Effect<Ready | null, ExecutorError>;
    readonly write: (ready: Ready) => Effect.Effect<void, ExecutorError>;
  }
>()("piper-executor/release/ReadyStore") {}
