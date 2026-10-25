import { describe, expect, it } from "@effect/vitest";
import { ExecutorError } from "@joelhooks/piper-executor/domain";
import { createEffectActor } from "@xstate/effect";
import { Effect, Layer, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import {
  readMachine,
  ReadAttempt,
  readWithBackoff,
} from "../src/read-machine.js";
import { answerAt, modelReads, openView, RULES } from "./read-machine-model.js";
import type {
  ReadOutcome,
  ReadStep,
  ReadView,
  Rule,
} from "./read-machine-model.js";

const REQUEST = {
  path: "/repos/sample/project/pulls/1",
  repo: "sample/project",
};

const between = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

const Answer = Schema.Struct({
  code: ExecutorError.fields.code,
  hint: between(0, 2500),
  reply: between(0, 7),
});

type AnswerSpec = typeof Answer.Type;

const histories = {
  answers: Arbitrary.array(Arbitrary.schema(Answer), { maxLength: 6 }),
};

const outcomeOf = (answer: AnswerSpec, index: number): ReadOutcome => {
  if (answer.reply === 0) {
    return Result.succeed({ body: `read ${index}` });
  }

  if (answer.reply === 1) {
    return Result.fail(
      new ExecutorError({
        code: answer.code,
        message: `refused ${index}`,
        retryAfterMs: answer.hint,
      })
    );
  }

  return Result.fail(
    answer.reply === 2
      ? new ExecutorError({ code: "secondary-limit", message: "no hint" })
      : new ExecutorError({
          code: "secondary-limit",
          message: "hinted",
          retryAfterMs: answer.hint,
        })
  );
};

const outcomesOf = (answers: readonly AnswerSpec[]) => answers.map(outcomeOf);

const attemptsLayer = (outcomes: readonly ReadOutcome[]) => {
  const requests: unknown[] = [];

  const layer = Layer.succeed(ReadAttempt, {
    read: (request) =>
      Effect.suspend(() => {
        const answer = answerAt(outcomes, requests.length);
        requests.push(request);

        return Result.isSuccess(answer)
          ? Effect.succeed(answer.success)
          : Effect.fail(answer.failure);
      }),
  });

  return { layer, requests };
};

const viewOf = (snapshot: {
  readonly context: Omit<ReadView, "value"> & {
    readonly request: typeof REQUEST;
  };
  readonly value: string;
}) => ({
  attempts: snapshot.context.attempts,
  delay: snapshot.context.delay,
  request: snapshot.context.request,
  result: snapshot.context.result,
  value: snapshot.value,
});

const expectedView = (view: ReadView) => ({ ...view, request: REQUEST });

const trailOf = (steps: readonly ReadStep[]) => [
  expectedView(openView()),
  ...steps.flatMap(({ after, rule }) =>
    rule === "backed-off"
      ? [expectedView(after), expectedView({ ...after, value: "reading" })]
      : [expectedView(after)]
  ),
];

const settle = Effect.fn("settle")(function* settle(ready: () => boolean) {
  for (let turn = 0; turn < 64 && !ready(); turn += 1) {
    yield* Effect.yieldNow;
  }
});

const pausesOf = (steps: readonly ReadStep[]) => {
  const pauses: { readonly delay: number; readonly reads: number }[] = [];

  for (const [index, { after, rule }] of steps.entries()) {
    if (rule === "backed-off" && after.delay > 0) {
      pauses.push({ delay: after.delay, reads: index + 1 });
    }
  }

  return pauses;
};

const replayActor = Effect.fn("replayActor")(function* replayActor(
  answers: readonly AnswerSpec[]
) {
  const outcomes = outcomesOf(answers);
  const steps = modelReads(outcomes);
  const trail = trailOf(steps);
  const fake = attemptsLayer(outcomes);

  const actor = yield* createEffectActor(readMachine, { input: REQUEST }).pipe(
    Effect.provide(fake.layer)
  );

  const seen = [viewOf(actor.getSnapshot())];
  actor.subscribe((snapshot) => {
    seen.push(viewOf(snapshot));
  });

  for (const { delay, reads } of pausesOf(steps)) {
    const why = steps
      .slice(0, reads)
      .map((step) => `${step.rule} -> ${step.after.value}@${step.after.delay}`)
      .join("\n");

    const paused = 2 * reads;
    yield* settle(() => seen.length >= paused);

    expect(seen, why).toEqual(trail.slice(0, paused));
    expect(fake.requests, why).toEqual(
      steps.slice(0, reads).map(() => REQUEST)
    );

    yield* TestClock.adjust(delay - 1);
    yield* settle(() => seen.length > paused);
    expect(seen, why).toHaveLength(paused);
    expect(fake.requests, why).toHaveLength(reads);
    yield* TestClock.adjust(1);
  }

  yield* settle(() => seen.length >= trail.length);
  const final = actor.getSnapshot();

  expect(seen).toEqual(trail);
  expect(final.status).toBe("done");

  yield* TestClock.adjust("1 hour");
  yield* settle(() => seen.length > trail.length);

  expect(actor.getSnapshot()).toBe(final);
  expect(seen).toHaveLength(trail.length);
  expect(fake.requests).toHaveLength(steps.length);
}, Effect.scoped);

const settleHost = Effect.fn("settleHost")(function* settleHost(
  answers: readonly AnswerSpec[]
) {
  const outcomes = outcomesOf(answers);
  const steps = modelReads(outcomes);
  const fake = attemptsLayer(outcomes);
  const settled: ReadOutcome[] = [];

  yield* readWithBackoff(REQUEST.repo, REQUEST.path).pipe(
    Effect.result,
    Effect.tap((result) =>
      Effect.sync(() => {
        settled.push(result);
      })
    ),
    Effect.provide(fake.layer),
    Effect.forkScoped
  );

  for (const { delay } of pausesOf(steps)) {
    yield* settle(() => false);
    yield* TestClock.adjust(delay);
  }

  yield* settle(() => settled.length > 0);

  expect(settled).toEqual([steps.at(-1)?.after.result]);
  expect(fake.requests).toHaveLength(steps.length);
}, Effect.scoped);

describe("read retry lifecycle model", () => {
  it.effect.prop(
    "the live actor matches the model after every read and waits exactly the hinted delay",
    histories,
    ({ answers }) => replayActor(answers),
    { arbitrary: { runs: 300 } }
  );

  it.effect.prop(
    "readWithBackoff returns the model's last outcome once the hinted delays elapse",
    histories,
    ({ answers }) => settleHost(answers),
    { arbitrary: { runs: 200 } }
  );

  it.effect("the generator reaches every rule the model encodes", () =>
    Effect.gen(function* coverage() {
      const samples = yield* Arbitrary.sampleEffect(Arbitrary.all(histories), {
        count: 400,
        seed: 17,
      }).pipe(Effect.orDie);

      const reached = new Map<Rule, number>();

      for (const { answers } of samples) {
        for (const { rule } of modelReads(outcomesOf(answers))) {
          reached.set(rule, (reached.get(rule) ?? 0) + 1);
        }
      }

      for (const rule of RULES) {
        expect(
          reached.get(rule) ?? 0,
          `${rule}: ${JSON.stringify(Object.fromEntries(reached))}`
        ).toBeGreaterThan(10);
      }
    })
  );
});
