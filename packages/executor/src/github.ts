import { Context, Effect, Layer } from "effect";

import type { ExecutorError } from "./domain.js";
import { TokenProvider } from "./token.js";
import { Transport } from "./transport.js";

export class GitHub extends Context.Service<
  GitHub,
  {
    readonly read: (
      repo: string,
      path: string
    ) => Effect.Effect<unknown, ExecutorError>;
  }
>()("piper-executor/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* makeGitHub() {
      const transport = yield* Transport;
      const provider = yield* TokenProvider;

      const read = Effect.fn("GitHub.read")(function* read(
        repo: string,
        path: string
      ) {
        const token = yield* provider.token;

        return yield* transport.request({
          method: "GET",
          token,
          url: `https://api.github.com/repos/${repo}${path}`,
        });
      });

      return GitHub.of({ read });
    })
  );
}
