import { Context } from "effect";
import type { Effect } from "effect";

import type { ExecutorError } from "./domain.js";

export class MessageSink extends Context.Service<
  MessageSink,
  {
    readonly page: (message: string) => Effect.Effect<void, ExecutorError>;
    readonly send: (message: string) => Effect.Effect<void, ExecutorError>;
  }
>()("piper-executor/release/MessageSink") {}
