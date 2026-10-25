import { describe, expect, it } from "@effect/vitest";
import { createEffectActor } from "@xstate/effect";
import { Effect, Exit, Layer, Option, Predicate, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";
import type { SnapshotFrom } from "xstate";

import { ExecutorError } from "../src/domain.js";
import type { Job } from "../src/domain.js";
import { executorMachine, runOnce } from "../src/drain.js";
import { GitHub } from "../src/github.js";
import { Journal, records } from "../src/journal.js";
import type { Entry } from "../src/journal.js";
import { Outbox } from "../src/worker.js";
import {
  appendRefusal,
  modelRun,
  OUTBOX_REFUSAL,
  postRefusal,
  READ_REFUSAL,
  RULES,
} from "./drain-model.js";
import type {
  Fact,
  Fault,
  JobKind,
  JobPlan,
  Rule,
  RunPlan,
  Trace,
} from "./drain-model.js";
import { BASE, car, dry, fake, HEAD, train } from "./fakes.js";

const between = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ maximum, minimum }));

const JobDraw = Schema.Struct({
  fault: between(0, 9),
  kind: Schema.Literals(["poll", "rerun", "build"]),
  slot: between(0, 3),
});

const RunDraw = Schema.Struct({
  appendFail: between(0, 17),
  jobs: Schema.Array(JobDraw).check(Schema.isMaxLength(4)),
  postFail: between(0, 5),
  readFail: between(0, 4),
});

type RunSpec = typeof RunDraw.Type;

const histories = {
  runs: Arbitrary.array(Arbitrary.schema(RunDraw), {
    maxLength: 4,
    minLength: 1,
  }),
};

const faultOf = (draw: number): Fault => {
  if (draw <= 1) {
    return "die";
  }

  return draw <= 3 ? "fail" : "none";
};

const planOf = (run: RunSpec): RunPlan => ({
  appendFail: Math.max(0, run.appendFail - 3),
  jobs: run.jobs.map((job) => ({
    fault: faultOf(job.fault),
    kind: job.kind,
    slot: job.slot,
  })),
  postFail: run.postFail,
  readFails: run.readFail === 0,
});

const idOf = (slot: number) => `train-1/${slot + 1}`;

const slotOf = (job: Job) => Number(job.intent.id.split("/")[1]) - 1;

const intentOf = {
  build: (stamp) => ({
    ...stamp,
    base: BASE,
    branch: "train/1",
    buildId: 1,
    cars: [car],
    kind: "BuildTrain",
    purpose: "train",
  }),
  poll: (stamp) => ({ ...stamp, head: HEAD, kind: "PollChecks" }),
  rerun: (stamp) => ({ ...stamp, head: HEAD, kind: "RerunChecks" }),
} satisfies Record<
  JobKind,
  (stamp: {
    readonly at: number;
    readonly id: string;
  }) => Parameters<typeof train>[0]
>;

const jobOf = (plan: JobPlan): Job =>
  train(intentOf[plan.kind]({ at: 0, id: idOf(plan.slot) }));

const failure = (described: string) => {
  const [code = "", message = ""] = described.split(": ");

  return new ExecutorError({
    code: Schema.decodeUnknownSync(ExecutorError.fields.code)(code),
    message,
  });
};

const described = (error: ExecutorError | null | undefined) =>
  error === null || error === undefined
    ? null
    : `${error.code}: ${error.message}`;

const factOf = (entry: Entry): Fact[] =>
  records.$match(entry, {
    claimed: ({ job }): Fact[] => [{ slot: slotOf(job), tag: "claimed" }],
    delivered: ({ job }): Fact[] => [{ slot: slotOf(job), tag: "delivered" }],
    delivering: ({ job }): Fact[] => [{ slot: slotOf(job), tag: "delivering" }],
    settled: ({ job, outcome }): Fact[] => [
      {
        error: described(outcome.error),
        events: outcome.events.map((event) => event._tag),
        slot: slotOf(job),
        status: outcome.status,
        tag: "settled",
      },
    ],
    "would-do": (): Fact[] => [],
  });

const harness = (journal: Entry[], plan: RunPlan) => {
  const trace: Trace[] = [];
  const plans = new Map<Job, JobPlan>();

  const jobs = plan.jobs.map((job) => {
    const built = jobOf(job);
    plans.set(built, job);

    return built;
  });

  const counts = { appends: 0, posts: 0 };
  let current: JobPlan | undefined;
  const fixture = fake();

  const github = Layer.effect(
    GitHub,
    Effect.gen(function* faultyGitHub() {
      const upstream = yield* GitHub;

      return GitHub.of({
        read: (repo, path) =>
          Effect.suspend(() => {
            if (current?.fault === "die") {
              return Effect.die("synthetic crash during execution");
            }

            return current?.fault === "fail"
              ? Effect.fail(failure(READ_REFUSAL))
              : upstream.read(repo, path);
          }),
      });
    })
  );

  const journalLayer = Layer.succeed(Journal, {
    append: (entry) =>
      Effect.suspend(() => {
        const index = counts.appends;
        counts.appends += 1;

        if (index === plan.appendFail) {
          return Effect.fail(failure(appendRefusal(index)));
        }

        journal.push(entry);

        for (const fact of factOf(entry)) {
          trace.push({ fact, step: "append" });
        }

        if (Predicate.isTagged(entry, "claimed")) {
          current = plans.get(entry.job);
        }

        return Effect.void;
      }),
    entries: Effect.sync(() => [...journal]),
  });

  const outbox = Layer.succeed(Outbox, {
    post: (job, events) =>
      Effect.suspend(() => {
        const index = counts.posts;
        counts.posts += 1;

        if (index === plan.postFail) {
          return Effect.fail(failure(postRefusal(index)));
        }

        trace.push({
          events: events.map((event) => event._tag),
          slot: slotOf(job),
          step: "post",
        });

        return Effect.void;
      }),
    read: Effect.suspend(() => {
      trace.push({ step: "read" });

      return plan.readFails
        ? Effect.fail(failure(OUTBOX_REFUSAL))
        : Effect.succeed(jobs);
    }),
  });

  const layer = Layer.mergeAll(
    journalLayer,
    outbox,
    github.pipe(Layer.provide(fixture.layer))
  ).pipe(Layer.provideMerge(fixture.layer));

  return { layer, trace };
};

const settle = Effect.fn("settle")(function* settle(ready: () => boolean) {
  for (let turn = 0; turn < 4096 && !ready(); turn += 1) {
    yield* Effect.yieldNow;
  }
});

const factsOf = (journal: readonly Entry[]) => journal.flatMap(factOf);

const whyOf = (plans: readonly RunPlan[], rules: readonly Rule[]) =>
  `${JSON.stringify(plans)}\n${rules.join(" ")}`;

const state = (snapshot: SnapshotFrom<typeof executorMachine>): Trace => ({
  error: described(snapshot.context.error),
  step: "state",
  value: snapshot.status === "error" ? "error" : snapshot.value,
});

const runActor = Effect.fn("runActor")(function* runActor(
  journal: Entry[],
  plan: RunPlan
) {
  const { layer, trace } = harness(journal, plan);

  const actor = yield* createEffectActor(executorMachine, {
    input: dry,
  }).pipe(Effect.provide(layer));

  trace.unshift(state(actor.getSnapshot()));
  actor.subscribe({
    error: () => {
      trace.push({ error: null, step: "state", value: "error" });
    },
    next: (snapshot) => {
      trace.push(state(snapshot));
    },
  });

  yield* settle(() => actor.getSnapshot().status !== "active");
  const final = actor.getSnapshot();
  const settled = trace.length;

  yield* TestClock.adjust("1 hour");
  yield* settle(() => trace.length > settled);

  expect(actor.getSnapshot()).toBe(final);
  expect(trace).toHaveLength(settled);

  return trace;
}, Effect.scoped);

const replayActor = Effect.fn("replayActor")(function* replayActor(
  runs: readonly RunSpec[]
) {
  const journal: Entry[] = [];
  const plans = runs.map(planOf);

  for (const [index, plan] of plans.entries()) {
    const expected = modelRun(factsOf(journal), plan);
    const why = whyOf(plans.slice(0, index + 1), expected.rules);
    const trace = yield* runActor(journal, plan);

    expect(trace, why).toEqual(expected.trace);
    expect(factsOf(journal), why).toEqual(expected.facts);
  }
});

const replayHost = Effect.fn("replayHost")(function* replayHost(
  runs: readonly RunSpec[]
) {
  const journal: Entry[] = [];
  const plans = runs.map(planOf);

  for (const [index, plan] of plans.entries()) {
    const expected = modelRun(factsOf(journal), plan);
    const why = whyOf(plans.slice(0, index + 1), expected.rules);
    const last = expected.trace.at(-1);
    const { layer } = harness(journal, plan);
    const exit = yield* runOnce(dry).pipe(Effect.exit, Effect.provide(layer));

    if (last?.step === "state" && last.value === "error") {
      expect(Exit.hasDies(exit), why).toBe(true);
    } else if (last?.step === "state" && last.error !== null) {
      expect(Exit.findErrorOption(exit), why).toEqual(
        Option.some(failure(last.error))
      );
    } else {
      expect(Exit.isSuccess(exit), why).toBe(true);
    }

    expect(factsOf(journal), why).toEqual(expected.facts);
  }
});

describe("executor drain lifecycle model", () => {
  it.effect.prop(
    "the live actor matches the model at every append, post and state across restarts",
    histories,
    ({ runs }) => replayActor(runs),
    { arbitrary: { runs: 300 } }
  );

  it.effect.prop(
    "runOnce succeeds, fails or dies as the model's final state says",
    histories,
    ({ runs }) => replayHost(runs),
    { arbitrary: { runs: 150 } }
  );

  it.effect("the generator reaches every rule the model encodes", () =>
    Effect.gen(function* coverage() {
      const samples = yield* Arbitrary.sampleEffect(Arbitrary.all(histories), {
        count: 400,
        seed: 17,
      }).pipe(Effect.orDie);

      const reached = new Map<Rule, number>();

      for (const { runs } of samples) {
        let facts: readonly Fact[] = [];

        for (const plan of runs.map(planOf)) {
          const run = modelRun(facts, plan);
          ({ facts } = run);

          for (const rule of run.rules) {
            reached.set(rule, (reached.get(rule) ?? 0) + 1);
          }
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
