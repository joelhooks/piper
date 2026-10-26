import { Context, Effect, Layer } from "effect";

import type { Containment } from "./domain.js";

export class CommitContains extends Context.Reference<
  (ancestor: string, descendant: string) => Effect.Effect<Containment>
>("piper-observe/CommitContains", {
  defaultValue: () => () => Effect.succeed("unknown"),
}) {
  static readonly layer = Layer.succeed(CommitContains, () =>
    Effect.succeed("unknown")
  );
}
