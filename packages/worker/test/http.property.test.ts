import { expect, it } from "@effect/vitest";
import { Effect, Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { stampedBody } from "../src/http.js";

const fields = Schema.Struct({
  label: Schema.String,
  value: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});

type Primitive = boolean | number | string | null;

type EventRecord = Readonly<Record<string, Primitive>>;

type RequestBody =
  | Primitive
  | EventRecord
  | readonly (Primitive | EventRecord)[];

const request = (body: RequestBody) =>
  new Request("https://example.test/events", {
    body: JSON.stringify(body),
    method: "POST",
  });

it.effect.prop(
  "server time fills missing timestamps without replacing caller evidence or changing batch order",
  {
    at: Arbitrary.schema(
      Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
    ),
    batch: Arbitrary.array(Arbitrary.schema(fields), { maxLength: 30 }),
    supplied: Arbitrary.schema(
      Schema.Union([
        Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
        Schema.String,
        Schema.Null,
      ])
    ),
  },
  ({ at, batch, supplied }) =>
    Effect.gen(function* scenario() {
      const mixed = batch.flatMap((item) => [item, { ...item, at: supplied }]);

      const expected = batch.flatMap((item) => [
        { ...item, at },
        { ...item, at: supplied },
      ]);

      expect(yield* stampedBody(request(mixed), at)).toEqual(expected);
      expect(yield* stampedBody(request({}), at)).toEqual({ at });
      expect(yield* stampedBody(request({}), 0)).toEqual({ at: 0 });
      expect(yield* stampedBody(request({ at: 0 }), at)).toEqual({ at: 0 });
      expect(yield* stampedBody(request({ at: supplied }), at)).toEqual({
        at: supplied,
      });
      expect(yield* stampedBody(request(expected), at + 1)).toEqual(expected);
    })
);

it.effect.prop(
  "a primitive or a batch containing any primitive is rejected rather than partially admitted",
  {
    batch: Arbitrary.array(Arbitrary.schema(fields), { maxLength: 30 }),
    primitive: Arbitrary.schema(
      Schema.Union([
        Schema.String,
        Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
        Schema.Boolean,
        Schema.Null,
      ])
    ),
  },
  ({ batch, primitive }) =>
    Effect.gen(function* scenario() {
      for (const body of [primitive, [...batch, primitive]]) {
        const result = yield* stampedBody(request(body), 0).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);

        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("BadRequest");
        }
      }
    })
);
