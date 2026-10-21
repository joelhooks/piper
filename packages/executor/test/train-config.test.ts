import { describe, expect, it } from "@effect/vitest";
import { decodePiperConfig, definePiperConfig } from "@joelhooks/piper/config";
import { TrainInputSchema } from "@joelhooks/piper/domain";
import { Effect, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";
import { TestClock } from "effect/testing";

import example from "../../core/examples/piper.config.ts";
import { trainAdmission } from "../src/train-config.js";
import type { TrainLaunch } from "../src/train-config.js";
import { TrainAdmissionSchema } from "../src/train-domain.js";
import type { TrainAdmission } from "../src/train-domain.js";
import { decodeTrainAdmission, runTrain } from "../src/train.js";
import { admission, direct, finish, fixture } from "./train-fixture.js";

const launchOf = ({
  car,
  goBy,
  mode,
  tokenCommand,
  train,
}: TrainAdmission): TrainLaunch => ({ car, goBy, mode, tokenCommand, train });

const configFor = (written: TrainAdmission) => {
  const [owner = "", name = ""] = written.repo.split("/");
  const { input } = written;

  return definePiperConfig({
    ...example,
    mergeLine: {
      ...example.mergeLine,
      checks: {
        direct: input.directRequiredChecks ?? [],
        ignored: input.ignoredChecks,
        ignoredAtBoarding: input.candidateIgnoredChecks ?? [],
        train: input.candidateRequiredChecks ?? [],
      },
      ciTimeoutMs: input.ciTimeoutMs,
      labels: {
        fullCi: `${input.trainLabel}-full-ci`,
        hold: `${input.trainLabel}-hold`,
        train: input.trainLabel,
      },
      maxCars: input.maxCars,
      pollMs: input.pollMs,
      requireUpToDate: input.requireUpToDate ?? true,
    },
    repo: { base: written.baseBranch, name, owner },
  });
};

const explicit = (written: TrainAdmission): TrainAdmission => ({
  ...written,
  input: {
    candidateIgnoredChecks: [],
    candidateRequiredChecks: [],
    directRequiredChecks: [],
    requireUpToDate: true,
    ...written.input,
  },
});

const Name = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,11}$/u));

const Groups = Schema.Array(Schema.NonEmptyArray(Name));

const handWritten = Arbitrary.schema(
  Schema.Struct({
    ...TrainAdmissionSchema.fields,
    baseBranch: Name,
    input: Schema.Struct({
      ...TrainInputSchema.fields,
      candidateIgnoredChecks: Schema.optionalKey(Schema.Array(Name)),
      candidateRequiredChecks: Schema.optionalKey(Groups),
      directRequiredChecks: Schema.optionalKey(Groups),
      ignoredChecks: Schema.Array(Name),
      trainLabel: Name,
    }),
    owner: Name,
    project: Name,
  })
).pipe(
  Arbitrary.map(({ owner, project, ...written }): TrainAdmission => {
    const repo = `${owner}/${project}`;

    return {
      ...written,
      input: { ...written.input, repo, train: written.train },
      repo,
    };
  })
);

const run = Effect.fn("TrainConfigTest.run")(function* run(
  admitted: TrainAdmission
) {
  const test = yield* fixture();

  const result = yield* finish(
    runTrain(admitted).pipe(Effect.provide(test.layer))
  );

  return { lines: yield* test.sink.lines, result, writes: test.github.writes };
}, Effect.provide(TestClock.layer()));

describe("train admission from PiperConfig", () => {
  it.effect(
    "builds an admission from the example config that the executor's admission schema decodes",
    () =>
      Effect.gen(function* exampleAdmission() {
        const config = yield* decodePiperConfig(example);

        const built = trainAdmission(config, {
          car: { headSha: "synthetic-head", number: 7 },
          goBy: "operator",
          mode: "dry-run",
          tokenCommand: "synthetic-token-command",
          train: 3,
        });

        const parsed = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Unknown)
        )(JSON.stringify(built));

        expect(yield* decodeTrainAdmission(parsed)).toEqual(built);
        expect(built).toEqual({
          baseBranch: "main",
          car: { headSha: "synthetic-head", number: 7 },
          goBy: "operator",
          input: {
            candidateIgnoredChecks: [],
            candidateRequiredChecks: [["unit"]],
            ciTimeoutMs: 3_600_000,
            directRequiredChecks: [["unit", "types"]],
            ignoredChecks: ["preview"],
            maxCars: 4,
            pollMs: 15_000,
            repo: "acme/shop",
            requireUpToDate: true,
            train: 3,
            trainLabel: "train",
          },
          mode: "dry-run",
          repo: "acme/shop",
          tokenCommand: "synthetic-token-command",
          train: 3,
        } satisfies TrainAdmission);
      })
  );

  it.effect.prop(
    "round-trips any hand-written admission through a config that says the same thing",
    { written: handWritten },
    ({ written }) =>
      Effect.gen(function* roundTrip() {
        const config = yield* decodePiperConfig(configFor(written));
        const built = trainAdmission(config, launchOf(written));

        expect(built).toEqual(explicit(written));
        expect(yield* decodeTrainAdmission(built)).toEqual(built);
      }),
    { arbitrary: { runs: 200 } }
  );

  it.effect(
    "a config-driven train lands exactly like the hand-written train and direct admissions",
    () =>
      Effect.gen(function* sameTrain() {
        for (const written of [admission, direct]) {
          const config = yield* decodePiperConfig(configFor(written));
          const expected = yield* run(written);

          expect(expected.result.exit).toBe("landed");
          expect(yield* run(trainAdmission(config, launchOf(written)))).toEqual(
            expected
          );
        }
      })
  );
});
