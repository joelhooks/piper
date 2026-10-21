import { ConfigProvider, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";

import { RecordSink } from "../src/record-sink.js";
import type { TrainAdmission, TrainState } from "../src/train-domain.js";
import { TrainStore } from "../src/train-store.js";
import { car, fake } from "./fakes.js";

export const admission: TrainAdmission = {
  baseBranch: "trunk",
  car: { headSha: car.headSha, number: car.number },
  goBy: "operator",
  input: {
    candidateRequiredChecks: [["unit"]],
    ciTimeoutMs: 60_000_000,
    ignoredChecks: [],
    maxCars: 1,
    pollMs: 60_000,
    repo: "sample/project",
    train: 1,
    trainLabel: "queue",
  },
  mode: "live",
  repo: "sample/project",
  tokenCommand: "synthetic-token-command",
  train: 1,
};

export const direct = {
  ...admission,
  input: { ...admission.input, directRequiredChecks: [["unit"]] },
} satisfies TrainAdmission;

export const fixture = Effect.fn("TrainTest.fixture")(function* fixture(
  initial: TrainState | null = null
) {
  const github = fake();
  github.controls.runner = true;
  const store = yield* TrainStore.memory(initial);
  const sink = yield* RecordSink.memory();
  const layer = Layer.mergeAll(github.layer, store.layer, sink.layer);

  return { github, layer, sink, store };
});

const admitted = Effect.provideService(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromUnknown({ PIPER_LIVE_ADMITTED_REPO: admission.repo })
);

export const finish = Effect.fn("TrainTest.finish")(function* finish<A, E, R>(
  task: Effect.Effect<A, E, R>
) {
  const fiber = yield* task.pipe(admitted, Effect.forkChild);
  yield* Effect.forEach(Array.from({ length: 40 }), () =>
    TestClock.adjust(60_000)
  );

  return yield* Fiber.join(fiber);
});
