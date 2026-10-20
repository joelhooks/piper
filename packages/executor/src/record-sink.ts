import { Console, Context, Effect, Layer, Ref } from "effect";

import type { ExecutorError } from "./domain.js";

export class RecordSink extends Context.Service<
  RecordSink,
  { readonly write: (line: string) => Effect.Effect<void, ExecutorError> }
>()("piper-executor/RecordSink") {
  static readonly console = Layer.succeed(RecordSink, { write: Console.log });

  static memory() {
    return Effect.gen(function* memorySink() {
      const lines = yield* Ref.make<readonly string[]>([]);

      return {
        layer: Layer.succeed(RecordSink, {
          write: (line) => Ref.update(lines, (current) => [...current, line]),
        }),
        lines: Ref.get(lines),
      };
    });
  }
}
