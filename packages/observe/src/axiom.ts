import { Array, DateTime, Effect, Option, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { ObserveError } from "./domain.js";
import type { AxiomSettings } from "./domain.js";
import { fetchJson } from "./http.js";
import type { Span } from "./policy.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const TableSchema = Schema.Struct({
  columns: Schema.Array(Schema.Array(Schema.NullOr(Schema.Finite))),
  fields: Schema.Array(Schema.Struct({ name: Schema.String })),
});

type Table = typeof TableSchema.Type;

const AplResultSchema = Schema.Struct({
  status: Schema.Struct({ isPartial: Schema.Boolean }),
  tables: Schema.Array(TableSchema),
});

export interface AxiomAccess {
  readonly orgId: Redacted.Redacted;
  readonly token: Redacted.Redacted;
}

export const iso = (millis: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(millis));

export const errorsQuery = (axiom: AxiomSettings) =>
  `['${axiom.dataset}'] | where (${axiom.filter}) | summarize requests = count(), errors = countif(toint(['${axiom.statusField}']) >= 500)`;

const cell = (table: Table, name: string) =>
  Option.flatMap(
    Array.findFirstIndex(table.fields, (field) => field.name === name),
    (index) => Option.fromNullishOr(table.columns[index]?.[0])
  );

const decodeCount = Schema.decodeUnknownOption(Count);

const readCounts = (tables: readonly Table[]) =>
  Array.findFirst(tables, (table) =>
    Option.isSome(cell(table, "requests"))
  ).pipe(
    Option.flatMap((table) =>
      Option.all({
        errors: Option.flatMap(cell(table, "errors"), decodeCount),
        requests: Option.flatMap(cell(table, "requests"), decodeCount),
      })
    )
  );

export const countRequests = Effect.fn("Observe.countRequests")(
  function* countRequests(
    axiom: AxiomSettings,
    access: AxiomAccess,
    span: Span
  ) {
    const request = yield* HttpClientRequest.post(
      "https://api.axiom.co/v1/datasets/_apl"
    ).pipe(
      HttpClientRequest.setUrlParam("format", "tabular"),
      HttpClientRequest.bearerToken(access.token),
      HttpClientRequest.setHeader(
        "x-axiom-org-id",
        Redacted.value(access.orgId)
      ),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyJson({
        apl: errorsQuery(axiom),
        endTime: iso(span.end),
        startTime: iso(span.start),
      }),
      Effect.mapError(
        () => new ObserveError({ reason: "Axiom query could not be encoded" })
      )
    );

    const result = yield* fetchJson("Axiom", request, AplResultSchema);

    if (result.status.isPartial) {
      return yield* new ObserveError({
        reason: "Axiom returned a partial result",
      });
    }

    const counts = readCounts(result.tables);

    if (Option.isNone(counts)) {
      return yield* new ObserveError({
        reason: "Axiom result lacks requests and errors columns",
      });
    }

    return counts.value;
  }
);
