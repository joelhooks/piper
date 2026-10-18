import { Schema } from "effect";

export const OperatorAcceptanceSchema = Schema.Struct({
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  by: Schema.NonEmptyString,
  kind: Schema.Literal("operator-acceptance"),
  nodes: Schema.Array(Schema.NonEmptyString),
});

export const landedNodes = (
  facts: readonly (typeof OperatorAcceptanceSchema.Type)[]
) => [...new Set(facts.flatMap((fact) => fact.nodes))];
