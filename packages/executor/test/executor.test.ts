import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Clock,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { drain, runOnce } from "../src/drain.js";
import { execute } from "../src/execute.js";
import { GitHub } from "../src/github.js";
import { landedNodes, OperatorAcceptanceSchema } from "../src/index.js";
import { Journal, records } from "../src/journal.js";
import type { Entry } from "../src/journal.js";
import { TokenProvider } from "../src/token.js";
import { Transport } from "../src/transport.js";
import { writers } from "../src/writes.js";
import { BASE, cases, dry, fake, HEAD, live, solo, train } from "./fakes.js";

const selections = Arbitrary.array(
  Arbitrary.schema(
    Schema.Int.check(Schema.isBetween({ maximum: 14, minimum: 0 }))
  ),
  { maxLength: 50 }
);

const cut = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 40, minimum: 0 }))
);

describe("executor intent translation", () => {
  for (const item of cases) {
    it.effect(
      `${item.job._tag} ${item.job.intent.kind} maps provider calls and events`,
      () =>
        Effect.gen(function* mapping() {
          const fixture = fake();

          const outcome = yield* execute(item.job, live).pipe(
            Effect.provide(fixture.layer)
          );

          expect(outcome.status).toBe("done");
          expect(
            fixture.writes.map(
              (operation) => `${operation.method} ${operation.path}`
            )
          ).toEqual(item.paths);
          expect(outcome.events.map((event) => event._tag)).toEqual(
            item.events
          );

          if (item.job.intent.kind === "Merge") {
            expect(fixture.writes[0]?.body).toEqual({
              merge_method: "merge",
              sha: HEAD,
            });
          }

          if (item.job.intent.kind === "BuildTrain") {
            expect(outcome.events).toContainEqual(
              expect.objectContaining({
                buildId: 1,
                conflicted: [],
                head: "built-a",
                merged: [1],
              })
            );
          }

          if (item.job.intent.kind === "PollChecks") {
            expect(outcome.events).toContainEqual(
              expect.objectContaining({
                checks: [
                  {
                    attempt: 2,
                    conclusion: "success",
                    headSha: HEAD,
                    id: 12,
                    name: "unit",
                    runId: 11,
                    status: "completed",
                  },
                ],
              })
            );
          }
        })
    );
  }

  it.effect.prop(
    "dry-run performs zero writes for generated intent streams",
    { choices: selections },
    ({ choices }) =>
      Effect.gen(function* shadow() {
        const fixture = fake();

        for (const choice of choices) {
          const item = cases[choice];

          if (item === undefined) {
            throw new Error("generator outside fixture range");
          }

          const outcome = yield* execute(item.job, dry).pipe(
            Effect.provide(fixture.layer)
          );

          expect(outcome.status).not.toBe("failed");

          if (item.paths.length > 0) {
            expect(outcome.status).toBe("recorded-would-do");
            expect(outcome.events).toEqual([]);
          }
        }

        expect(fixture.writes).toEqual([]);
        expect(
          fixture.records.every(
            (record) =>
              record.head.length > 0 &&
              record.intentId.length > 0 &&
              record.wouldDo.length > 0
          )
        ).toBe(true);
      }),
    { arbitrary: { runs: 200 } }
  );

  it.effect("dry-run never constructs the live writer Layer", () =>
    Effect.gen(function* dryConstruction() {
      const layer = writers("dry-run", () => {
        throw new Error("constructed live write layer");
      });

      yield* Layer.build(layer).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            TokenProvider.fromValue(Redacted.make("synthetic")),
            Layer.succeed(Transport, {
              request: () => Effect.die("dry-run constructed transport"),
            })
          )
        )
      );
    })
  );

  it.effect("missing token fails closed before any transport call", () =>
    Effect.gen(function* missingToken() {
      const requests: string[] = [];

      const transport = Layer.succeed(Transport, {
        request: (request) =>
          Effect.sync(() => {
            requests.push(request.url);

            return null;
          }),
      });

      const github = GitHub.layer.pipe(
        Layer.provide(
          Layer.merge(transport, TokenProvider.fromValue(Redacted.make("")))
        )
      );

      const outcome = yield* GitHub.use((api) =>
        api.read("sample/project", "/pulls/1")
      ).pipe(Effect.result, Effect.provide(github));

      expect(outcome).toHaveProperty("_tag", "Failure");
      expect(outcome).toHaveProperty("failure.code", "missing-token");
      expect(requests).toEqual([]);
    })
  );

  it.effect(
    "a dry run opens its train PR without reading a branch it never wrote",
    () =>
      Effect.gen(function* openWithoutRef() {
        const job = train({
          at: 1,
          base: BASE,
          branch: "train/1",
          cars: [],
          id: "train-1/2",
          kind: "OpenTrainPr",
        });

        const dryRun = fake([job]);
        dryRun.controls.refMissing = true;
        yield* runOnce(dry).pipe(Effect.provide(dryRun.layer));
        expect(
          dryRun.records.flatMap((record) =>
            record.wouldDo.map((write) => write.path)
          )
        ).toEqual(["/pulls"]);
        expect(dryRun.reads).toEqual([]);

        const liveRun = fake([job]);
        liveRun.controls.refMissing = true;

        yield* Effect.exit(runOnce(live).pipe(Effect.provide(liveRun.layer)));

        expect(liveRun.reads).toEqual(["/git/ref/heads/train%2F1"]);
        expect(liveRun.writes).toEqual([]);
      })
  );

  it.effect("live label removal treats an absent label as removed", () =>
    Effect.gen(function* absentLabel() {
      const job = train({
        at: 1,
        id: "train-1/9",
        kind: "RemoveLabels",
        label: "train",
        prs: [1, 3],
      });

      const fixture = fake([job]);
      fixture.controls.labelMissing = true;

      const outcome = yield* execute(job, live).pipe(
        Effect.provide(fixture.layer)
      );

      expect(outcome.status).toBe("done");
      expect(
        fixture.writes.map(
          (operation) => `${operation.method} ${operation.path}`
        )
      ).toEqual([
        "DELETE /issues/1/labels/train",
        "DELETE /issues/3/labels/train",
      ]);
    })
  );

  it.effect("merge head mismatch posts mergeRefused without a write", () =>
    Effect.gen(function* mismatch() {
      const job = train({
        at: 1,
        id: "train-1/2",
        kind: "Merge",
        matchHead: HEAD,
        pr: 3,
      });

      const fixture = fake([job]);
      fixture.controls.head = "newer-head";
      yield* runOnce(live).pipe(Effect.provide(fixture.layer));
      expect(fixture.writes).toEqual([]);
      expect(fixture.posted.map((event) => event._tag)).toEqual([
        "mergeRefused",
      ]);
      expect(fixture.posted).toContainEqual(
        expect.objectContaining({ head: HEAD })
      );
    })
  );

  it.effect(
    "a build conflict becomes a built event with the car excluded",
    () =>
      Effect.gen(function* conflict() {
        const fixture = fake();
        fixture.controls.conflict = true;
        const [first] = cases;

        if (first === undefined) {
          throw new Error("missing build fixture");
        }

        const outcome = yield* execute(first.job, live).pipe(
          Effect.provide(fixture.layer)
        );

        expect(outcome.events).toContainEqual(
          expect.objectContaining({
            conflicted: [1],
            head: BASE,
            merged: [],
          })
        );
      })
  );

  it.effect(
    "baseline dispatch binds a branch to the exact base and records no synthetic success",
    () =>
      Effect.gen(function* baselineDispatch() {
        const fixture = fake();
        fixture.controls.baseline = false;

        const job = solo({
          at: 1,
          base: BASE,
          checks: ["unit"],
          id: "solo-1/1",
          kind: "RunBaseline",
          pr: 1,
        });

        const outcome = yield* execute(job, dry).pipe(
          Effect.provide(fixture.layer)
        );

        expect(outcome).toMatchObject({
          events: [],
          status: "recorded-would-do",
        });
        expect(fixture.records[0]?.head).toBe(BASE);
        expect(fixture.records[0]?.wouldDo).toEqual([
          {
            body: { ref: "refs/heads/piper-baseline/solo-1%2F1", sha: BASE },
            method: "POST",
            path: "/git/refs",
          },
          {
            body: { ref: "piper-baseline/solo-1%2F1" },
            method: "POST",
            path: "/actions/workflows/unit.yml/dispatches",
          },
        ]);

        const polled = yield* execute(
          solo({
            at: 2,
            checks: ["unit"],
            id: "solo-1/2",
            kind: "PollChecks",
            pr: 1,
            sha: BASE,
          }),
          dry
        ).pipe(Effect.provide(fixture.layer));

        expect(polled.events).toContainEqual(
          expect.objectContaining({ base: BASE })
        );
      })
  );

  it.effect(
    "only explicit operator acceptance supplies landed plan credit",
    () =>
      Effect.gen(function* credit() {
        const acceptance = OperatorAcceptanceSchema.make({
          at: 1,
          by: "operator-a",
          kind: "operator-acceptance",
          nodes: ["node-a"],
        });

        expect(landedNodes([])).toEqual([]);
        expect(landedNodes([acceptance, acceptance])).toEqual(["node-a"]);
        const fixture = fake();

        const outcome = yield* execute(
          train({ at: 1, head: HEAD, id: "train-1/3", kind: "PollChecks" }),
          dry
        ).pipe(Effect.provide(fixture.layer));

        expect(outcome.events.map((event) => event._tag)).toEqual(["checks"]);
      })
  );
});

describe("durable at-most-once intent claims", () => {
  it.effect.prop(
    "a crash after a provider call never replays a claimed intent",
    { choices: selections, n: cut },
    ({ choices, n }) =>
      Effect.gen(function* restart() {
        const jobs = choices.map((choice, index) =>
          train({
            at: index,
            id: `train-1/${index + 1}`,
            kind: "Merge",
            matchHead: HEAD,
            pr: choice + 1,
          })
        );

        const entries: Entry[] = [];
        const split = jobs.length === 0 ? 0 : n % jobs.length;
        const prefix = fake(jobs.slice(0, split), entries);
        yield* runOnce(live).pipe(Effect.provide(prefix.layer));
        const interrupted = jobs[split];

        const crashing = fake(
          interrupted === undefined ? [] : [interrupted],
          entries
        );

        crashing.controls.crash = true;

        const crashed = yield* drain(live).pipe(
          Effect.exit,
          Effect.provide(crashing.layer)
        );

        if (interrupted !== undefined) {
          expect(Exit.isFailure(crashed)).toBe(true);
        }

        const resumed = fake(jobs, entries);
        yield* runOnce(live).pipe(Effect.provide(resumed.layer));

        const total =
          prefix.writes.length + crashing.writes.length + resumed.writes.length;

        expect(total).toBe(jobs.length);
        expect(
          entries.filter((entry) => Predicate.isTagged(entry, "settled"))
        ).toHaveLength(jobs.length);
        const repeats = fake(jobs, entries);
        yield* runOnce(live).pipe(Effect.provide(repeats.layer));
        expect(repeats.writes).toEqual([]);
      }),
    { arbitrary: { runs: 100 } }
  );

  it.effect("an ambiguous event POST is never retried automatically", () =>
    Effect.gen(function* ambiguousDelivery() {
      const job = train({
        at: 1,
        head: HEAD,
        id: "train-1/1",
        kind: "PollChecks",
      });

      const fixture = fake([job]);
      fixture.controls.failPost = true;

      const first = yield* runOnce(dry).pipe(
        Effect.result,
        Effect.provide(fixture.layer)
      );

      expect(first).toHaveProperty("_tag", "Failure");
      fixture.controls.failPost = false;
      yield* runOnce(dry).pipe(Effect.provide(fixture.layer));
      expect(fixture.posted).toEqual([]);
      expect(
        fixture.entries.filter((entry) =>
          Predicate.isTagged(entry, "delivering")
        )
      ).toHaveLength(1);
      expect(
        fixture.entries.filter((entry) =>
          Predicate.isTagged(entry, "delivered")
        )
      ).toHaveLength(0);
    })
  );

  it.effect("file-backed claims survive reopening the journal", () =>
    Effect.gen(function* persistedJournal() {
      const fs = yield* FileSystem.FileSystem;

      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "piper-executor-",
      });

      const job = train({
        at: 1,
        id: "train-1/1",
        kind: "Merge",
        matchHead: HEAD,
        pr: 3,
      });

      yield* Journal.use((journal) =>
        journal.append(records.claimed({ job }))
      ).pipe(Effect.provide(Journal.file(directory)));
      const fixture = fake([job]);
      const runtime = Layer.merge(fixture.layer, Journal.file(directory));
      yield* runOnce(live).pipe(Effect.provide(runtime));
      expect(fixture.writes).toEqual([]);

      const persisted = yield* Journal.use((journal) => journal.entries).pipe(
        Effect.provide(Journal.file(directory))
      );

      const recovered = persisted.find((entry) =>
        Predicate.isTagged(entry, "settled")
      );

      expect(recovered).toHaveProperty("outcome.status", "failed");
      expect(recovered).toHaveProperty("outcome.error.code", "interrupted");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
  );
});

const rateFixture = (interval: number, secondary: boolean) =>
  Effect.gen(function* makeRateFixture() {
    const times: number[] = [];

    const client = HttpClient.make((request) =>
      Effect.gen(function* respond() {
        times.push(yield* Clock.currentTimeMillis);

        return HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            headers: { "retry-after": "2" },
            status: secondary && times.length === 1 ? 429 : 204,
          })
        );
      })
    );

    const layer = Transport.layer(interval).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client))
    );

    const calls = Transport.use((transport) =>
      Effect.all(
        Array.from({ length: 8 }, () =>
          transport
            .request({
              method: "GET",
              token: Redacted.make("synthetic"),
              url: "https://provider.invalid/read",
            })
            .pipe(Effect.result)
        ),
        { concurrency: "unbounded" }
      )
    );

    const fiber = yield* calls.pipe(Effect.provide(layer), Effect.forkChild);

    return { fiber, times };
  });

describe("provider read pacing", () => {
  it.effect(
    "a secondary limit delays subsequent calls by at least sixty seconds",
    () =>
      Effect.gen(function* secondaryLimit() {
        const fixture = yield* rateFixture(1000, true);
        yield* TestClock.adjust(66_000);
        const outcomes = yield* Fiber.join(fixture.fiber);
        expect(outcomes[0]).toHaveProperty("_tag", "Failure");
        expect(outcomes[0]).toHaveProperty("failure.code", "secondary-limit");
        expect(fixture.times).toEqual([
          0, 60_000, 61_000, 62_000, 63_000, 64_000, 65_000, 66_000,
        ]);
      })
  );
  it.effect("a concurrent burst respects the configured minimum spacing", () =>
    Effect.gen(function* burst() {
      const fixture = yield* rateFixture(1000, false);
      yield* TestClock.adjust(0);
      expect(fixture.times).toHaveLength(1);
      yield* TestClock.adjust(7000);
      yield* Fiber.join(fixture.fiber);
      expect(fixture.times).toEqual([
        0, 1000, 2000, 3000, 4000, 5000, 6000, 7000,
      ]);
    })
  );
});
