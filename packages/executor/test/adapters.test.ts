import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";

import { ExecutorError } from "../src/domain.js";
import { execute } from "../src/execute.js";
import { TokenProvider } from "../src/token.js";
import { Transport } from "../src/transport.js";
import type { Request } from "../src/transport.js";
import { Outbox } from "../src/worker.js";
import { GitHubWrites } from "../src/writes.js";
import { dry, fake, HEAD, live, solo, train } from "./fakes.js";

const token = Redacted.make("synthetic-token");

describe("executor adapter seams", () => {
  it.effect(
    "Worker discovery decodes both outboxes and posts the exact event batch",
    () =>
      Effect.gen(function* workerBoundary() {
        const calls: Request[] = [];

        const layer = Outbox.worker(
          "sample/project",
          "https://worker.invalid",
          token
        ).pipe(
          Layer.provide(
            Layer.succeed(Transport, {
              request: (request) =>
                Effect.sync(() => {
                  calls.push(request);
                  const { pathname } = new URL(request.url);

                  switch (pathname) {
                    case "/trains": {
                      return [{ train: 1 }];
                    }

                    case "/solos": {
                      return [{ key: "pr-1@head-a" }];
                    }

                    case "/trains/1": {
                      return {
                        head: HEAD,
                        intents: [
                          {
                            at: 1,
                            id: "train-1/1",
                            kind: "Merge",
                            matchHead: HEAD,
                            pr: 3,
                          },
                        ],
                        repo: "sample/project",
                      };
                    }

                    case "/solos/pr-1%40head-a": {
                      return {
                        head: HEAD,
                        intents: [
                          {
                            at: 1,
                            checks: ["unit"],
                            id: "solo-1/1",
                            kind: "PollChecks",
                            pr: 1,
                            sha: HEAD,
                          },
                        ],
                        repo: "sample/project",
                      };
                    }

                    default: {
                      return {};
                    }
                  }
                }),
            })
          )
        );

        const jobs = yield* Outbox.use((outbox) => outbox.read).pipe(
          Effect.provide(layer)
        );

        expect(jobs.map((job) => [job._tag, job.intent.id])).toEqual([
          ["train", "train-1/1"],
          ["solo", "solo-1/1"],
        ]);
        const [job] = jobs;

        if (job === undefined) {
          throw new Error("missing discovered job");
        }

        const fixture = fake();
        fixture.controls.head = "changed-head";

        const outcome = yield* execute(job, live).pipe(
          Effect.provide(fixture.layer)
        );

        yield* Outbox.use((outbox) => outbox.post(job, outcome.events)).pipe(
          Effect.provide(layer)
        );
        expect(calls.at(-1)?.url).toBe(
          "https://worker.invalid/trains/1/events"
        );
        expect(calls.at(-1)?.body).toEqual(outcome.events);
        expect(
          calls.every(
            (call) => Redacted.value(call.token) === "synthetic-token"
          )
        ).toBe(true);
      })
  );

  it.effect(
    "the live GitHub writer enforces the token and retains the sha precondition",
    () =>
      Effect.gen(function* writeBoundary() {
        const calls: Request[] = [];

        const transport = Layer.succeed(Transport, {
          request: (request) =>
            Effect.sync(() => {
              calls.push(request);

              return null;
            }),
        });

        const layer = GitHubWrites.live().pipe(
          Layer.provide(
            Layer.merge(transport, TokenProvider.fromValue(token, 60_000))
          )
        );

        const job = train({
          at: 1,
          id: "train-1/1",
          kind: "Merge",
          matchHead: HEAD,
          pr: 3,
        });

        yield* GitHubWrites.use((github) =>
          github.write(job, {
            body: { sha: HEAD },
            method: "PUT",
            path: "/pulls/3/merge",
          })
        ).pipe(Effect.provide(layer));
        expect(calls[0]?.body).toEqual({ sha: HEAD });
        expect(calls[0]?.url).toBe(
          "https://api.github.com/repos/sample/project/pulls/3/merge"
        );

        const refused = GitHubWrites.live().pipe(
          Layer.provide(
            Layer.merge(transport, TokenProvider.fromValue(Redacted.make("")))
          )
        );

        const failure = yield* GitHubWrites.use((github) =>
          github.write(job, {
            body: { sha: HEAD },
            method: "PUT",
            path: "/pulls/3/merge",
          })
        ).pipe(Effect.result, Effect.provide(refused));

        expect(failure).toHaveProperty("failure.code", "missing-token");
        expect(calls).toHaveLength(1);
      })
  );

  it.effect("expired and overlong token leases fail closed", () =>
    Effect.gen(function* tokenExpiry() {
      for (const expiresAt of [-1, 0, 3_600_001]) {
        const result = yield* TokenProvider.use(
          (provider) => provider.token
        ).pipe(
          Effect.result,
          Effect.provide(TokenProvider.fromValue(token, expiresAt))
        );

        expect(result).toHaveProperty("failure.code", "missing-token");
      }
    })
  );

  it.effect("a provider refusing the guarded merge posts mergeRefused", () =>
    Effect.gen(function* providerRefusal() {
      const fixture = fake();

      const refused = Layer.succeed(GitHubWrites, {
        write: () =>
          Effect.fail(
            new ExecutorError({
              code: "head-mismatch",
              message: "synthetic 409",
            })
          ),
      });

      const outcome = yield* execute(
        train({
          at: 1,
          id: "train-1/1",
          kind: "Merge",
          matchHead: HEAD,
          pr: 3,
        }),
        live
      ).pipe(Effect.provide(Layer.merge(fixture.layer, refused)));

      expect(outcome.events.map((event) => event._tag)).toEqual([
        "mergeRefused",
      ]);
    })
  );

  it.effect(
    "a missing baseline mapping fails typed instead of dispatching arbitrary CI",
    () =>
      Effect.gen(function* missingMapping() {
        const fixture = fake();
        fixture.controls.baseline = false;

        const outcome = yield* execute(
          solo({
            at: 1,
            base: "base-a",
            checks: ["unmapped"],
            id: "solo-1/1",
            kind: "RunBaseline",
            pr: 1,
          }),
          dry
        ).pipe(Effect.provide(fixture.layer));

        expect(outcome).toHaveProperty("error.code", "configuration");
        expect(fixture.writes).toEqual([]);
        expect(fixture.records).toEqual([]);
      })
  );

  it.effect(
    "rerun falls back to explicit check-run IDs only when no workflow IDs exist",
    () =>
      Effect.gen(function* rerequest() {
        const fixture = fake();

        const outcome = yield* execute(
          solo({
            at: 1,
            checkRunIds: [12, 12],
            checks: ["unit"],
            head: HEAD,
            id: "solo-1/1",
            kind: "RerunFailed",
            pr: 1,
            workflowRunIds: [],
          }),
          live
        ).pipe(Effect.provide(fixture.layer));

        expect(outcome.status).toBe("done");
        expect(fixture.writes.map((write) => write.path)).toEqual([
          "/check-runs/12/rerequest",
        ]);
      })
  );
});
