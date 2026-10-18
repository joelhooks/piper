import { describe, expect, it } from "@effect/vitest";
import type {
  PostedEvent,
  PostedSoloEvent,
  CheckRun,
} from "@joelhooks/piper/domain";
import { Data, Effect } from "effect";

import { bodyOf, memory, request } from "./memory.js";

const TrainEvent = Data.taggedEnum<PostedEvent>();

const SoloEvent = Data.taggedEnum<PostedSoloEvent>();

const TOKEN = "test-token";

const key = "/solos/pr-7@head";

const opening = JSON.stringify({
  at: 0,
  base: "base",
  checks: [
    {
      attempt: 1,
      conclusion: "failure",
      headSha: "head",
      id: 1,
      name: "unit",
      status: "completed",
    },
  ],
  head: "head",
  owner: "contributor",
  pr: 7,
});

const open = Effect.fn("MetricsTest.open")(function* open(
  host: ReturnType<typeof memory>
) {
  expect(
    (yield* host.fetch(request("/solos", "POST", opening, TOKEN))).status
  ).toBe(201);
});

describe("metrics HTTP API", () => {
  it.effect(
    "leaves metrics open by default and protects it with read auth",
    () =>
      Effect.gen(function* scenario() {
        expect(
          (yield* memory({}).fetch(request("/metrics", "GET"))).status
        ).toBe(200);
        const host = memory({ API_TOKEN: TOKEN, REQUIRE_READ_AUTH: "true" });
        expect((yield* host.fetch(request("/metrics", "GET"))).status).toBe(
          401
        );
        expect(host.documents.size).toBe(0);
        expect(
          (yield* host.fetch(request("/metrics", "GET", undefined, "wrong")))
            .status
        ).toBe(401);
        expect(
          (yield* host.fetch(request("/metrics", "GET", undefined, TOKEN)))
            .status
        ).toBe(200);
      })
  );

  it.effect(
    "aggregates the Depot ledgers without persisting a projection and filters by fact time",
    () =>
      Effect.gen(function* scenario() {
        const host = memory();
        yield* open(host);
        expect(
          (yield* host.fetch(
            request(
              `${key}/events`,
              "POST",
              JSON.stringify(
                SoloEvent.checks({
                  at: 60_000,
                  checks: [
                    {
                      attempt: 2,
                      conclusion: "success",
                      headSha: "head",
                      id: 1,
                      name: "unit",
                      status: "completed",
                    },
                  ],
                  head: "head",
                })
              ),
              TOKEN
            )
          )).status
        ).toBe(200);
        const before = [...host.documents];
        const response = yield* host.fetch(request("/metrics", "GET"));
        expect(response.status).toBe(200);
        expect(yield* bodyOf(response)).toMatchObject({
          prsLandedPerCiRun: { ciRuns: 0, landed: 0, rate: null },
          solo: {
            checks: [
              {
                attempts: { baseline: 0, original: 1, rerun: 1 },
                flakeRate: 1,
                name: "unit",
              },
            ],
            outcomes: { flake: 1 },
          },
        });
        expect(
          yield* bodyOf(
            yield* host.fetch(request("/metrics?since=60000", "GET"))
          )
        ).toMatchObject({
          solo: {
            checks: [{ attempts: { original: 0, rerun: 1 }, flakeRate: 1 }],
            outcomes: { flake: 1 },
          },
        });
        expect(
          yield* bodyOf(
            yield* host.fetch(request("/metrics?since=60001", "GET"))
          )
        ).toMatchObject({
          solo: { checks: [], outcomes: { flake: 0 } },
        });
        expect([...host.documents]).toEqual(before);

        for (const since of [
          "",
          "abc",
          "-1",
          "1.5",
          "Infinity",
          "9007199254740992",
        ]) {
          expect(
            (yield* host.fetch(request(`/metrics?since=${since}`, "GET")))
              .status
          ).toBe(400);
        }
      })
  );

  it.effect("aggregates train landing and timing samples across cells", () =>
    Effect.gen(function* scenario() {
      const host = memory();

      for (const n of [1, 2]) {
        expect(
          (yield* host.fetch(
            request("/trains", "POST", JSON.stringify({ train: n }), TOKEN)
          )).status
        ).toBe(201);
        const head = `train-${n}`;

        const checks: readonly CheckRun[] = [
          {
            conclusion: "success",
            headSha: head,
            name: "unit",
            status: "completed",
          },
        ];

        const events = [
          TrainEvent.candidates({
            at: 0,
            candidates: [
              {
                checks: checks.map((check) => ({
                  ...check,
                  headSha: `car-${n}`,
                })),
                headSha: `car-${n}`,
                labels: ["train"],
                number: n,
                operatorReviewed: true,
                owner: "contributor",
                upToDate: true,
              },
            ],
            main: "base",
          }),
          TrainEvent.depart({ at: 0 }),
          TrainEvent.built({
            at: 0,
            buildId: 1,
            conflicted: [],
            head,
            merged: [n],
          }),
          TrainEvent.checks({ at: 60_000, checks, head }),
          TrainEvent.prOpened({ at: 60_000, pr: n + 100 }),
          TrainEvent.go({ at: 60_000, by: "operator", head }),
          TrainEvent.merged({
            at: (n + 1) * 60_000,
            head,
            mergeSha: `merge-${n}`,
          }),
        ];

        expect(
          (yield* host.fetch(
            request(
              `/trains/${n}/events`,
              "POST",
              JSON.stringify(events),
              TOKEN
            )
          )).status
        ).toBe(200);
      }

      expect(
        yield* bodyOf(yield* host.fetch(request("/metrics", "GET")))
      ).toMatchObject({
        greenToMergedMinutes: { median: 1.5, p90: 2, samples: 2 },
        prsLandedPerCiRun: { ciRuns: 2, landed: 2, rate: 1 },
      });
    })
  );
});
