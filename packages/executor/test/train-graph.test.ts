import { expect, it } from "@effect/vitest";
import { createEffectActor, waitFor } from "@xstate/effect";
import { ConfigProvider, Effect, Predicate } from "effect";
import type { StateValue } from "xstate";

import { trainRunnerMachine } from "../src/train.js";
import { admission, finish, fixture } from "./train-fixture.js";

const stateName = (value: StateValue): string =>
  Predicate.isString(value)
    ? value
    : Object.entries(value)
        .map(([parent, child]) => `${parent}.${stateName(child ?? {})}`)
        .join(",");

it.effect(
  "the reachable graph exposes boarding, riding, each drain loop and all three endings",
  () =>
    Effect.gen(function* graph() {
      const traces: string[][] = [];

      for (const mode of ["landed", "rehearsed", "stopped"]) {
        const test = yield* fixture();
        test.github.controls.carHead =
          mode === "stopped" ? "unreviewed" : admission.car.headSha;

        const scenario = Effect.gen(function* trace() {
          const actor = yield* createEffectActor(trainRunnerMachine, {
            input: {
              admission: {
                ...admission,
                mode: mode === "rehearsed" ? "dry-run" : "live",
              },
              seen: [],
              stop: undefined,
              train: undefined,
              writes: 0,
            },
          });

          expect(Object.keys(actor.getSnapshot().context).toSorted()).toEqual([
            "admission",
            "seen",
            "stop",
            "train",
            "writes",
          ]);

          const names = [stateName(actor.getSnapshot().value)];

          const subscription = actor.subscribe((snapshot) => {
            names.push(stateName(snapshot.value));
          });

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              subscription.unsubscribe();
            })
          );
          yield* waitFor(actor, (snapshot) => snapshot.status === "done").pipe(
            Effect.orDie
          );

          return names;
        }).pipe(Effect.scoped, Effect.provide(test.layer));

        traces.push(yield* finish(scenario));
      }

      expect([...new Set(traces.flat())].toSorted()).toEqual([
        "boarding.draining",
        "boarding.polling",
        "landed",
        "preparing",
        "rehearsed",
        "riding.draining",
        "riding.polling",
        "stopped",
      ]);
      expect(
        traces[0]?.filter((state) => state.startsWith("boarding."))
      ).toEqual(["boarding.polling", "boarding.draining"]);
      expect(traces[1]).toEqual([
        "preparing",
        "boarding.polling",
        "boarding.draining",
        "rehearsed",
      ]);
      expect(traces[2]).toEqual(["preparing", "boarding.polling", "stopped"]);
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ PIPER_LIVE_ADMITTED_REPO: admission.repo })
      )
    )
);
