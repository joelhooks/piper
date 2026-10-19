import { describe, expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { projectWouldDo } from "../src/project.js";

const heads = Arbitrary.schema(Schema.NonEmptyString);

const intent = {
  at: 1,
  id: "synthetic/merge",
  kind: "Merge",
  matchHead: "declared-head",
  pr: 1,
} as const;

describe("would-do projection", () => {
  it.prop(
    "compares the payload SHA, not the intent's declared SHA",
    { head: heads },
    ({ head }) => {
      const projected = projectWouldDo(
        {
          head: intent.matchHead,
          intentId: intent.id,
          kind: intent.kind,
          repo: "sample/project",
          wouldDo: [
            { body: { sha: head }, method: "PUT", path: "/pulls/1/merge" },
          ],
        },
        intent
      );

      expect(Result.isSuccess(projected)).toBe(true);

      if (Result.isSuccess(projected)) {
        expect(projected.success.head).toBe(head);
      }
    }
  );

  it("rejects an undecodable journal payload instead of inventing a match", () => {
    expect(
      Result.isFailure(
        projectWouldDo(
          {
            head: intent.matchHead,
            intentId: intent.id,
            kind: intent.kind,
            repo: "sample/project",
            wouldDo: [
              { body: { sha: null }, method: "PUT", path: "/pulls/1/merge" },
            ],
          },
          intent
        )
      )
    ).toBe(true);
  });
});
