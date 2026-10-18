import { Context, Effect, Layer } from "effect";

import type { ExecutorError, Job, Mode, Write } from "./domain.js";
import { TokenProvider } from "./token.js";
import { Transport } from "./transport.js";

export class GitHubWrites extends Context.Service<
  GitHubWrites,
  {
    readonly write: (
      job: Job,
      write: Write
    ) => Effect.Effect<unknown, ExecutorError>;
  }
>()("piper-executor/GitHubWrites") {
  static live() {
    return Layer.effect(
      GitHubWrites,
      Effect.gen(function* makeWrites() {
        const transport = yield* Transport;
        const provider = yield* TokenProvider;

        const write = Effect.fn("GitHubWrites.write")(function* write(
          job: Job,
          operation: Write
        ) {
          const token = yield* provider.token;

          return yield* transport.request({
            body: operation.body,
            method: operation.method,
            token,
            url:
              operation.path === "/graphql"
                ? "https://api.github.com/graphql"
                : `https://api.github.com/repos/${job.repo}${operation.path}`,
          });
        });

        return GitHubWrites.of({ write });
      })
    );
  }
}

export const writers = (
  mode: Mode,
  live: () => Layer.Layer<
    GitHubWrites,
    never,
    Transport | TokenProvider
  > = () => GitHubWrites.live()
) =>
  mode === "dry-run"
    ? Layer.succeed(GitHubWrites, {
        write: () => Effect.die("Dry-run attempted a live write"),
      })
    : live();
