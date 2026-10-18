import { Context, Effect, Layer, Schema } from "effect";
import type { Redacted } from "effect";

import { decode } from "./boundary.js";
import { ExecutorError, JobSchema } from "./domain.js";
import type { Event, Job } from "./domain.js";
import { Transport } from "./transport.js";

export class Outbox extends Context.Service<
  Outbox,
  {
    readonly read: Effect.Effect<readonly Job[], ExecutorError>;
    readonly post: (
      job: Job,
      events: readonly Event[]
    ) => Effect.Effect<void, ExecutorError>;
  }
>()("piper-executor/Outbox") {
  static worker(repo: string, api: string, token: Redacted.Redacted) {
    return Layer.effect(
      Outbox,
      Effect.gen(function* makeOutbox() {
        const transport = yield* Transport;

        const request = (
          method: "GET" | "POST",
          path: string,
          body?: readonly Event[]
        ) => {
          const url = `${api.replace(/\/$/u, "")}${path}`;

          return transport.request(
            body === undefined
              ? { method, token, url }
              : { body, method, token, url }
          );
        };

        const read = Effect.gen(function* read() {
          const jobs: Job[] = [];

          const trains = yield* decode(
            Schema.Array(Schema.Struct({ train: Schema.Int }))
          )(yield* request("GET", "/trains"));

          const solos = yield* decode(
            Schema.Array(Schema.Struct({ key: Schema.String }))
          )(yield* request("GET", "/solos"));

          if (trains.length + solos.length > 1000) {
            return yield* new ExecutorError({
              code: "configuration",
              message: "Worker collection exceeds executor read bound",
            });
          }

          const targets = [
            ...trains.map((train) => ({
              path: `/trains/${train.train}`,
              tag: "train",
            })),
            ...solos.map((solo) => ({
              path: `/solos/${encodeURIComponent(solo.key)}`,
              tag: "solo",
            })),
          ];

          for (const target of targets) {
            const view = yield* decode(
              Schema.Struct({
                head: Schema.optionalKey(Schema.String),
                intents: Schema.Array(Schema.Unknown),
                repo: Schema.String,
              })
            )(yield* request("GET", target.path));

            if (view.repo !== repo) {
              return yield* new ExecutorError({
                code: "configuration",
                message: "Worker repo does not match configured repo",
              });
            }

            if (view.intents.length > 10_000) {
              return yield* new ExecutorError({
                code: "configuration",
                message: "Worker outbox exceeds executor read bound",
              });
            }

            for (const intent of view.intents) {
              const summary = yield* decode(
                Schema.Struct({
                  base: Schema.optionalKey(Schema.String),
                  head: Schema.optionalKey(Schema.String),
                  matchHead: Schema.optionalKey(Schema.String),
                  sha: Schema.optionalKey(Schema.String),
                })
              )(intent);

              const head =
                view.head ??
                summary.head ??
                summary.sha ??
                summary.matchHead ??
                summary.base;

              jobs.push(
                yield* decode(JobSchema)({
                  _tag: target.tag,
                  head,
                  intent,
                  repo,
                  target: target.path,
                })
              );
            }
          }

          return jobs;
        });

        const post = Effect.fn("Outbox.post")(function* post(
          job: Job,
          events: readonly Event[]
        ) {
          if (events.length > 0) {
            yield* request("POST", `${job.target}/events`, events);
          }
        });

        return Outbox.of({ post, read });
      })
    );
  }
}
