import { Context } from "effect";
import type { Effect } from "effect";

import type { ExecutorError, WouldDo } from "./domain.js";

export class Recorder extends Context.Service<
  Recorder,
  { readonly append: (record: WouldDo) => Effect.Effect<void, ExecutorError> }
>()("piper-executor/Recorder") {}
