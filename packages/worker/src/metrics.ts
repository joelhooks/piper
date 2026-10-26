import { PrNumber } from "@joelhooks/piper/domain";
import { summarizeMetrics } from "@joelhooks/piper/metrics";
import type { SoloMetrics, TrainMetrics } from "@joelhooks/piper/metrics";
import { Effect, Schema } from "effect";

import { decode, json } from "./http.js";
import { forward } from "./transport.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Minutes = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const Outcomes = Schema.Struct({
  baseRed: Count,
  dismissed: Count,
  flake: Count,
  infra: Count,
  regression: Count,
  superseded: Count,
  unknown: Count,
});

const TrainMeasurements = Schema.Struct({
  bisects: Count,
  ciRuns: Count,
  culprits: Count,
  departures: Schema.Struct({
    "direct-land": Count,
    "lone-board": Count,
    train: Count,
  }),
  greenToMerged: Schema.Array(Minutes),
  landed: Count,
  mergeToLive: Schema.Array(Minutes),
  rebuilds: Schema.Struct({
    bisected: Count,
    conflict: Count,
    "head-moved": Count,
    "main-moved": Count,
    "merge-refused": Count,
  }),
});

const SoloMeasurements = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      attempts: Schema.Struct({
        baseline: Count,
        original: Count,
        rerun: Count,
      }),
      name: Schema.String,
      outcomes: Outcomes,
    })
  ),
  outcomes: Outcomes,
});

const bodyOf = (response: Response) =>
  Effect.promise(response.json.bind(response));

export const metricsOptions = Effect.fn("Metrics.options")(
  function* metricsOptions(request: Request) {
    const value = new URL(request.url).searchParams.get("since");

    if (value === null) {
      return {};
    }

    const since = yield* decode(
      Schema.String.check(Schema.isPattern(/^\d+$/u))
    )(value);

    return { since: yield* decode(Count)(Number(since)) };
  }
);

export const readMetrics = Effect.fn("Metrics.read")(function* readMetrics(
  request: Request
) {
  const options = yield* metricsOptions(request);
  const suffix = options.since === undefined ? "" : `?since=${options.since}`;
  const trains: TrainMetrics[] = [];
  const solos: SoloMetrics[] = [];

  const trainList = yield* forward("DEPOT", "depot", "/trains");

  if (!trainList.ok) {
    return trainList;
  }

  const trainEntries = yield* decode(
    Schema.Array(Schema.Struct({ n: PrNumber }))
  )(yield* bodyOf(trainList));

  for (const { n } of trainEntries) {
    const response = yield* forward("TRAIN", `train-${n}`, `/metrics${suffix}`);

    if (!response.ok) {
      return response;
    }

    trains.push(yield* decode(TrainMeasurements)(yield* bodyOf(response)));
  }

  const soloList = yield* forward("DEPOT", "depot", "/solos");

  if (!soloList.ok) {
    return soloList;
  }

  const soloEntries = yield* decode(
    Schema.Array(Schema.Struct({ key: Schema.String }))
  )(yield* bodyOf(soloList));

  for (const { key } of soloEntries) {
    const response = yield* forward("SOLO", key, `/metrics${suffix}`);

    if (!response.ok) {
      return response;
    }

    solos.push(yield* decode(SoloMeasurements)(yield* bodyOf(response)));
  }

  return json(summarizeMetrics(trains, solos));
});
