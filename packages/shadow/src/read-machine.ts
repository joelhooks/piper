import { ExecutorError } from "@joelhooks/piper-executor/domain";
import {
  createEffectActor,
  createEffectLogic,
  setupEffect,
  waitFor,
} from "@xstate/effect";
import { Context, Effect, Result, Schema } from "effect";

const RequestSchema = Schema.Struct({
  path: Schema.String,
  repo: Schema.String,
});

export class ReadAttempt extends Context.Service<
  ReadAttempt,
  {
    readonly read: (
      request: typeof RequestSchema.Type
    ) => Effect.Effect<unknown, ExecutorError>;
  }
>()("piper-shadow/ReadAttempt") {}

const requestTask = createEffectLogic({
  effect: ({ input }) =>
    ReadAttempt.use((reader) => reader.read(input)).pipe(Effect.result),
  schemas: { input: RequestSchema },
});

const backoffTask = createEffectLogic({
  effect: ({ input }) => Effect.sleep(input),
  schemas: { input: Schema.Finite },
});

export const readMachine = setupEffect({
  actors: { backoffTask, requestTask },
  schemas: {
    context: Schema.Struct({
      attempts: Schema.Int,
      delay: Schema.Finite,
      request: RequestSchema,
      result: Schema.Result(Schema.Unknown, ExecutorError),
    }),
    input: RequestSchema,
  },
}).createMachine({
  context: ({ input }) => ({
    attempts: 0,
    delay: 0,
    request: input,
    result: Result.fail(
      new ExecutorError({ code: "interrupted", message: "Read did not finish" })
    ),
  }),
  initial: "reading",
  states: {
    backoff: {
      invoke: {
        input: ({ context }) => context.delay,
        onDone: { target: "reading" },
        src: "backoffTask",
      },
    },
    done: { type: "final" },
    reading: {
      invoke: {
        input: ({ context }) => context.request,
        onDone: ({ context, event }) => {
          const result = event.output;
          const attempts = context.attempts + 1;

          if (
            Result.isFailure(result) &&
            result.failure.code === "secondary-limit" &&
            result.failure.retryAfterMs !== undefined &&
            attempts < 4
          ) {
            return {
              context: {
                ...context,
                attempts,
                delay: result.failure.retryAfterMs,
                result,
              },
              target: "backoff",
            };
          }

          return { context: { ...context, attempts, result }, target: "done" };
        },
        src: "requestTask",
      },
    },
  },
});

export const readWithBackoff = Effect.fn("Shadow.readWithBackoff")(
  function* readWithBackoff(repo: string, path: string) {
    const actor = yield* createEffectActor(readMachine, {
      input: { path, repo },
    });

    yield* waitFor(actor, (snapshot) => snapshot.status === "done").pipe(
      Effect.orDie
    );
    const { result } = actor.getSnapshot().context;

    return yield* Result.isSuccess(result)
      ? Effect.succeed(result.success)
      : Effect.fail(result.failure);
  },
  Effect.scoped
);
