import type { WouldDo } from "@joelhooks/piper-executor/domain";
import type { Intent } from "@joelhooks/piper/domain";
import { Result, Schema } from "effect";

import type { ActionValues } from "./domain.js";
import { ShadowError } from "./domain.js";

const ShaBody = Schema.Struct({ sha: Schema.String });

const MergeBody = Schema.Struct({
  commit_message: Schema.String,
  head: Schema.String,
});

const OpenBody = Schema.Struct({
  body: Schema.String,
  draft: Schema.Literal(true),
  head: Schema.String,
});

const bad = () =>
  new ShadowError({ message: "Would-do payload cannot be normalized" });

const membersIn = (text: string) =>
  [...text.matchAll(/(?:Cars:|,)\s*(?<pr>\d+)/gu)].map((match) =>
    Number(match.groups?.pr)
  );

const build = (record: WouldDo) =>
  Result.gen(function* projectBuild() {
    const [reference, ...merges] = record.wouldDo;

    const base = yield* Schema.decodeUnknownResult(ShaBody)(
      reference?.body
    ).pipe(Result.mapError(bad));

    const cars = yield* Schema.decodeUnknownResult(Schema.Array(MergeBody))(
      merges.map((operation) => operation.body)
    ).pipe(Result.mapError(bad));

    const members = cars.map((car) =>
      Number(/^Train car (?<pr>\d+)$/u.exec(car.commit_message)?.groups?.pr)
    );

    yield* Schema.decodeUnknownResult(Schema.Array(Schema.Int))(members).pipe(
      Result.mapError(bad)
    );

    return {
      cars: cars.map((car) => car.head),
      head: base.sha,
      kind: "BuildTrain",
      members,
    } satisfies ActionValues;
  });

const open = (
  record: WouldDo,
  intent: Extract<Intent, { readonly kind: "OpenTrainPr" }>
) =>
  Result.gen(function* projectOpen() {
    const [operation] = record.wouldDo;

    const body = yield* Schema.decodeUnknownResult(OpenBody)(
      operation?.body
    ).pipe(Result.mapError(bad));

    const members = membersIn(body.body);

    return {
      cars: members.flatMap((number) =>
        intent.cars.flatMap((car) =>
          car.number === number ? [car.headSha] : []
        )
      ),
      head: record.head,
      kind: "OpenTrainPr",
      members,
    } satisfies ActionValues;
  });

const labelActions = (record: WouldDo) =>
  Result.gen(function* projectLabels() {
    const values = record.wouldDo.map(
      (operation) =>
        /^\/issues\/(?<pr>\d+)\/labels\/(?<label>.+)$/u.exec(operation.path)
          ?.groups
    );

    const prs = values.map((groups) => Number(groups?.pr));
    yield* Schema.decodeUnknownResult(Schema.Array(Schema.Int))(prs).pipe(
      Result.mapError(bad)
    );

    const labels = yield* Result.try({
      catch: bad,
      try: () =>
        values.map((groups) => decodeURIComponent(groups?.label ?? "")),
    });

    const [label] = labels;

    if (
      label === undefined ||
      label === "" ||
      labels.some((value) => value !== label)
    ) {
      return yield* Result.fail(bad());
    }

    return {
      head: record.head,
      kind: "RemoveLabels",
      label,
      prs,
    } satisfies ActionValues;
  });

export const projectWouldDo = (
  record: WouldDo,
  intent: Intent
): Result.Result<ActionValues, ShadowError> => {
  switch (intent.kind) {
    case "BuildTrain": {
      return build(record);
    }

    case "OpenTrainPr": {
      return open(record, intent);
    }

    case "Merge": {
      const [operation] = record.wouldDo;

      return Schema.decodeUnknownResult(ShaBody)(operation?.body).pipe(
        Result.mapError(bad),
        Result.map((body) => ({
          head: body.sha,
          kind: "Merge",
          prs: [intent.pr],
        }))
      );
    }

    case "RemoveLabels": {
      return labelActions(record);
    }

    case "MarkReady":
    case "CloseTrainPr": {
      return Result.succeed({
        head: record.head,
        kind: intent.kind,
        prs: [intent.pr],
      });
    }

    case "NotifyOwner": {
      return Result.succeed({
        head: record.head,
        kind: intent.kind,
        prs: [intent.car.number],
      });
    }

    case "RerunChecks": {
      return Result.succeed({ head: record.head, kind: intent.kind });
    }

    case "PollChecks":
    case "RankSuspects": {
      return Result.fail(bad());
    }

    default: {
      return intent satisfies never;
    }
  }
};
