import type { Intent, TrainEvent } from "@joelhooks/piper/domain";
import { PostedEventSchema, toTrainEvent } from "@joelhooks/piper/domain";
import {
  openTrain,
  readTrain,
  stateName,
  stepTrain,
} from "@joelhooks/piper/host";
import type {
  PersistedTrain,
  TrainFinished,
  TrainSnapshot,
} from "@joelhooks/piper/host";
import {
  Clock,
  Config,
  Data,
  Effect,
  Predicate,
  Schedule,
  Schema,
} from "effect";

import { decode } from "./boundary.js";
import { CarStillAdmitted } from "./car-admission.js";
import type { ExecutorError, Job } from "./domain.js";
import { execute, readChecks } from "./execute.js";
import { GitHub } from "./github.js";
import type { RecordSink } from "./record-sink.js";
import type { TrainAdmission, TrainStop } from "./train-domain.js";
import {
  admittedIntent,
  endsRehearsal,
  failedStop,
  rerunFaults,
  rerunRefusal,
  stops,
  unavailable,
} from "./train-policy.js";
import { restoreTrain } from "./train-snapshot.js";
import { recordTrain, TrainStore } from "./train-store.js";

export interface RunnerContext {
  readonly admission: TrainAdmission | undefined;
  readonly seen: readonly string[];
  readonly stop: TrainStop | undefined;
  readonly train: PersistedTrain | undefined;
  readonly writes: number;
}

const recoverLedger = Effect.fn("Train.recoverLedger")(function* recoverLedger(
  context: RunnerContext,
  message: string
) {
  const store = yield* TrainStore;
  const saved = yield* store.load.pipe(Effect.orElseSucceed(() => null));

  return {
    ...context,
    seen: saved?.seen ?? context.seen,
    stop: unavailable(message),
    writes: saved?.writes ?? context.writes,
  };
});

const observe = Effect.fn("Train.observe")(function* observe<
  R,
  E extends { readonly message: string },
>(
  context: RunnerContext,
  task: Effect.Effect<RunnerContext, E, R>,
  intent?: Intent["kind"]
) {
  const next = yield* task.pipe(
    Effect.catch((error) => recoverLedger(context, error.message))
  );

  const snapshot =
    next.train === undefined ? undefined : yield* readTrain(next.train);

  return { context: next, intent, snapshot };
});

const save = Effect.fn("Train.save")(function* save(context: RunnerContext) {
  const store = yield* TrainStore;

  if (context.train !== undefined) {
    yield* store.save({
      seen: context.seen,
      train: context.train,
      writes: context.writes,
    });
  }
});

export const initializeTrain = Effect.fn("Train.initialize")(
  function* initializeTrain(context: RunnerContext) {
    const { admission } = context;

    if (admission === undefined || context.stop !== undefined) {
      return context;
    }

    const allowed = yield* Config.String("PIPER_LIVE_ADMITTED_REPO").pipe(
      Config.withDefault("")
    );

    if (admission.mode === "live" && allowed !== admission.repo) {
      return {
        ...context,
        stop: stops.LiveNotAdmitted({
          detail: { repo: admission.repo },
          harm: "writing to a repository the operator did not admit",
          next: "set PIPER_LIVE_ADMITTED_REPO to the admitted repo",
          stop: "live repo not admitted",
        }),
      };
    }

    if (
      admission.input.repo !== admission.repo ||
      admission.input.train !== admission.train
    ) {
      return {
        ...context,
        stop: stops.InvalidAdmission({
          detail: null,
          harm: "executing a different train from the admission",
          next: "make input.repo and input.train match the admission",
          stop: "invalid admission",
        }),
      };
    }

    const store = yield* TrainStore;
    const existing = yield* store.load;

    if (existing !== null && existing.writes > 0) {
      return {
        ...context,
        stop: stops.ResumeAfterWrites({
          detail: existing.writes,
          harm: "double writes",
          next: "hand back; the owner decides",
          stop: "resume after writes",
        }),
        writes: existing.writes,
      };
    }

    const train =
      existing === null
        ? yield* openTrain(admission.input)
        : yield* restoreTrain(existing);

    const snapshot = yield* readTrain(train);

    if (
      snapshot.context.repo !== admission.repo ||
      snapshot.context.train !== admission.train
    ) {
      return {
        ...context,
        stop: stops.InvalidAdmission({
          detail: null,
          harm: "resuming a different train",
          next: "use the state directory for this admission",
          stop: "saved train outside admission",
        }),
      };
    }

    const ready: RunnerContext = {
      ...context,
      seen: (existing?.seen ?? []).filter(
        (id) =>
          !snapshot.context.intents.some(
            (intent) =>
              intent.id === id && endsRehearsal(admission.mode, intent.kind)
          )
      ),
      train,
    };

    yield* save(ready);
    yield* recordTrain({
      car: admission.car,
      mode: admission.mode,
      repo: admission.repo,
      start: admission.train,
    });

    return ready;
  }
);

const RefSchema = Schema.Struct({
  object: Schema.Struct({ sha: Schema.NonEmptyString }),
});

const PullSchema = Schema.Struct({
  head: Schema.Struct({ sha: Schema.NonEmptyString }),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  user: Schema.Struct({ login: Schema.NonEmptyString }),
});

const CompareSchema = Schema.Struct({
  merge_base_commit: Schema.Struct({ sha: Schema.NonEmptyString }),
});

interface PollObservation {
  readonly admission: TrainAdmission;
  readonly at: number;
  readonly base: string;
  readonly pull: typeof PullSchema.Type;
  readonly snapshot: TrainSnapshot;
  readonly train: PersistedTrain;
}

type PostObservation = (
  observation: PollObservation
) => Effect.Effect<PersistedTrain, ExecutorError | TrainFinished, GitHub>;

const goFor = (
  admission: TrainAdmission,
  at: number,
  head: string | undefined
): readonly TrainEvent[] =>
  head === undefined ? [] : [{ at, by: admission.goBy, head, type: "go" }];

const depart = Effect.fn("Train.depart")(function* depart({
  admission,
  at,
  base,
  pull,
  train,
}: PollObservation) {
  const github = yield* GitHub;

  const departed = yield* stepTrain(train, [
    {
      at,
      candidates: [
        {
          checks: yield* readChecks(admission.repo, admission.car.headSha),
          headSha: admission.car.headSha,
          labels: [
            ...pull.labels.map((label) => label.name),
            admission.input.trainLabel,
          ],
          number: admission.car.number,
          operatorReviewed: true,
          owner: pull.user.login,
          upToDate:
            (yield* decode(CompareSchema)(
              yield* github.read(
                admission.repo,
                `/compare/${encodeURIComponent(base)}...${encodeURIComponent(admission.car.headSha)}`
              )
            )).merge_base_commit.sha === base,
        },
      ],
      main: base,
      type: "candidates",
    },
    { at, type: "depart" },
  ]);

  const go = goFor(admission, at, (yield* readTrain(departed)).context.head);

  return go.length === 0 ? departed : yield* stepTrain(departed, go);
});

const tick = ({ admission, at, snapshot, train }: PollObservation) =>
  stepTrain(train, [
    { at, type: "tick" },
    ...goFor(admission, at, snapshot.context.head),
  ]);

const poll = Effect.fn("Train.poll")(function* poll(
  context: RunnerContext,
  post: PostObservation
): Effect.fn.Return<
  RunnerContext,
  ExecutorError | TrainFinished,
  GitHub | TrainStore | RecordSink
> {
  const { admission, train } = context;

  if (admission === undefined || train === undefined) {
    return context;
  }

  const snapshot = yield* readTrain(train);

  if (snapshot.status !== "active") {
    return stateName(snapshot) === "landed"
      ? context
      : {
          ...context,
          stop: stops.TrainEnded({
            detail: null,
            harm: "continuing a train whose lifecycle ended",
            next: "inspect the final state and start a new train if needed",
            stop: `train ended ${stateName(snapshot)}`,
          }),
        };
  }

  const github = yield* GitHub;

  const base = yield* decode(RefSchema)(
    yield* github.read(
      admission.repo,
      `/git/ref/heads/${encodeURIComponent(admission.baseBranch)}`
    )
  );

  if (
    snapshot.context.build !== undefined &&
    snapshot.context.merged === undefined &&
    base.object.sha !== snapshot.context.build.base
  ) {
    return {
      ...context,
      stop: stops.BaseMoved({
        detail: { base: base.object.sha, built: snapshot.context.build.base },
        harm: "merging a combination CI never tested",
        next: "start a new train on the current base",
        stop: "base moved after the build",
      }),
    };
  }

  const pull = yield* decode(PullSchema)(
    yield* github.read(admission.repo, `/pulls/${admission.car.number}`)
  );

  if (pull.head.sha !== admission.car.headSha) {
    const moved = yield* stepTrain(train, [
      {
        actualHead: pull.head.sha,
        admittedHead: admission.car.headSha,
        at: yield* Clock.currentTimeMillis,
        pr: admission.car.number,
        type: "carHeadMoved",
      },
    ]);

    const reason = `car head moved from ${admission.car.headSha} to ${pull.head.sha}`;

    const dispatched = snapshot.context.intents.some(
      (intent) => intent.kind === "Merge"
    );

    const next = {
      ...context,
      stop: stops.CarMoved({
        detail: { actual: pull.head.sha, admitted: admission.car.headSha },
        harm: "landing a head nobody reviewed",
        next: dispatched
          ? "inspect the merge before rebuilding"
          : "name the new head",
        stop: dispatched
          ? `${reason}; whole train handed back because merge already dispatched`
          : reason,
      }),
      train: moved,
    };

    yield* save(next);

    return next;
  }

  const at = yield* Clock.currentTimeMillis;

  const observed = yield* post({
    admission,
    at,
    base: base.object.sha,
    pull,
    snapshot,
    train,
  });

  const after = yield* readTrain(observed);

  yield* Effect.forEach(
    after.context.facts
      .slice(snapshot.context.facts.length)
      .flatMap((fact) => (fact.kind === "departed" ? [fact] : [])),
    (fact) =>
      recordTrain({
        base: fact.base,
        cars: fact.cars,
        path: fact.path,
        reason: fact.reason,
      })
  );
  yield* recordTrain({
    cars: after.context.cars.length,
    head: after.context.head,
    pr: after.context.pr,
    state: stateName(after),
  });
  const next = { ...context, train: observed };
  yield* save(next);

  return next;
});

export const boardTrain = (context: RunnerContext) =>
  observe(context, poll(context, depart));

export const pollTrain = Effect.fn("Train.ridingPoll")(function* pollTrain(
  context: RunnerContext
) {
  if (context.admission !== undefined) {
    yield* Effect.void.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(context.admission.input.pollMs),
        times: 1,
      })
    );
  }

  return yield* observe(context, poll(context, tick));
});

const jobs = Data.taggedEnum<Job>();

const drain = Effect.fn("Train.drain")(function* drain(
  context: RunnerContext,
  intent: Intent
) {
  const { admission, train } = context;

  if (admission === undefined || train === undefined) {
    return context;
  }

  const snapshot = yield* readTrain(train);

  const checks =
    intent.kind === "RerunChecks"
      ? yield* readChecks(admission.repo, intent.head)
      : snapshot.context.checks;

  const refusal =
    admittedIntent(admission, intent) ??
    (intent.kind === "RerunChecks"
      ? rerunRefusal(checks, admission, intent.head)
      : undefined);

  if (refusal !== undefined) {
    return { ...context, stop: refusal };
  }

  if (intent.kind === "Merge" && admission.mode === "live") {
    const port = yield* CarStillAdmitted;

    const revoked: {
      readonly car: TrainAdmission["car"];
      readonly reason: string;
    }[] = [];

    for (const car of snapshot.context.cars) {
      const status = yield* port.check({
        car,
        repo: admission.repo,
        train: admission.train,
      });

      yield* recordTrain({ admission: status, car });

      if (Predicate.isTagged(status, "Revoked")) {
        revoked.push({ car, reason: status.reason });
      }
    }

    const [first] = revoked;

    if (first !== undefined) {
      return {
        ...context,
        stop: stops.GoRevoked({
          detail: revoked,
          harm: "landing a car its owner no longer approves",
          next: "get a new GO from the owner, then board the car again",
          stop: `GO revoked for car #${first.car.number}: ${first.reason}`,
        }),
      };
    }
  }

  if (intent.kind === "RerunChecks") {
    yield* recordTrain({
      faults: rerunFaults(checks, admission, intent.head).map((check) => ({
        conclusion: check.conclusion,
        name: check.name,
        runId: check.runId,
      })),
      head: intent.head,
      rerun: true,
    });
  }

  yield* recordTrain({
    id: intent.id,
    intent: intent.kind,
    mode: admission.mode,
  });

  const claimed = {
    ...context,
    seen: [...context.seen, intent.id],
    writes:
      context.writes +
      (admission.mode === "live" && intent.kind !== "PollChecks" ? 1 : 0),
  };

  yield* save(claimed);

  const outcome = yield* execute(
    jobs.train({
      head: snapshot.context.head ?? admission.car.headSha,
      intent,
      repo: admission.repo,
      target: `/trains/${admission.train}`,
    }),
    {
      baseBranch: admission.baseBranch,
      baselineWorkflows: {},
      mode: admission.mode,
    }
  );

  const events = yield* decode(Schema.Array(PostedEventSchema))(outcome.events);
  yield* recordTrain({ done: intent.kind, events, status: outcome.status });

  if (outcome.status === "failed") {
    return { ...claimed, stop: failedStop(intent, outcome.error) };
  }

  if (events.some(Predicate.isTagged("mergeRefused"))) {
    return {
      ...claimed,
      stop: stops.MergeRefused({
        detail: events,
        harm: "merging a head the provider refused",
        next: "hand back; inspect the refusal and tested head",
        stop: "merge refused",
      }),
    };
  }

  const updated =
    events.length === 0
      ? train
      : yield* stepTrain(train, events.map(toTrainEvent));

  const next: RunnerContext = {
    ...claimed,
    train: updated,
  };

  yield* save(next);

  return next;
});

export const drainTrain = Effect.fn("Train.drainSafe")(function* drainTrain(
  context: RunnerContext
) {
  const snapshot =
    context.train === undefined ? undefined : yield* readTrain(context.train);

  const intent = snapshot?.context.intents.find(
    (entry) => !context.seen.includes(entry.id)
  );

  return yield* observe(
    context,
    intent === undefined ? Effect.succeed(context) : drain(context, intent),
    intent?.kind
  );
});

export const prepareTrain = (context: RunnerContext) =>
  observe(context, initializeTrain(context));
