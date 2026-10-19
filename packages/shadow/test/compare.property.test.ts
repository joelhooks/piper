import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import { compare } from "../src/compare.js";
import type { ActionValues, OperatorAction, Trace } from "../src/domain.js";
import { mergeTraces } from "../src/trace.js";

const heads = Arbitrary.schema(Schema.NonEmptyString);

const merge = (head: string): ActionValues => ({
  head,
  kind: "Merge",
  prs: [1],
});

const observed = (head: string): OperatorAction => ({
  ...merge(head),
  at: 1,
  mergeSha: "merge-result",
  slot: 0,
  source: "synthetic:github",
});

const accepted = (head: string): Trace => ({
  acceptances: [
    {
      fact: {
        at: 2,
        by: "synthetic-operator",
        kind: "operator-acceptance",
        nodes: ["node-a"],
      },
      head,
    },
  ],
  actions: [observed(head)],
  complete: true,
});

describe("shadow evidence invariants", () => {
  it.prop(
    "an exact head and explicit acceptance match",
    { head: heads },
    ({ head }) => {
      expect(compare([merge(head)], accepted(head)).status).toBe("match");
    }
  );

  it.prop(
    "a merge alone never earns acceptance",
    { head: heads },
    ({ head }) => {
      expect(
        compare([merge(head)], { ...accepted(head), acceptances: [] }).status
      ).toBe("pending");
      expect(
        compare([merge(head)], { ...accepted(head), complete: false }).status
      ).toBe("pending");
    }
  );

  it.prop(
    "acceptance for another head never earns credit",
    { head: heads },
    ({ head }) => {
      expect(
        compare([merge(`${head}-new`)], {
          ...accepted(head),
          actions: [observed(`${head}-new`)],
        }).status
      ).toBe("pending");
    }
  );

  it.prop(
    "a changed head is a diff, even with acceptance",
    { head: heads },
    ({ head }) => {
      const result = compare([merge(head)], accepted(`${head}-other`));
      expect(result.status).toBe("diff");
      expect(
        result.differences.some(
          (difference) => difference.kind === "different head"
        )
      ).toBe(true);
    }
  );

  it.prop(
    "conflicting sources keep both values and never select a winner",
    { head: heads },
    ({ head }) => {
      const github = accepted(head);

      const log = {
        ...github,
        actions: [
          { ...observed(`${head}-other`), source: "synthetic:private-log" },
        ],
      };

      const merged = mergeTraces([github, log]);
      const result = compare([merge(head)], merged);

      const conflict = result.differences.find(
        (difference) => difference.kind === "conflict"
      );

      expect(result.status).toBe("diff");
      expect(conflict?.observed.map((action) => action.head)).toEqual([
        head,
        `${head}-other`,
      ]);
      expect(merged.actions).toHaveLength(2);
    }
  );

  it("combines partial fields with per-field source evidence", () => {
    const expected = {
      cars: ["car-a", "car-b"],
      head: "base",
      kind: "BuildTrain",
      members: [1, 2],
    } as const;

    const trace = mergeTraces([
      {
        acceptances: [],
        actions: [
          {
            at: 0,
            cars: expected.cars,
            head: "base",
            kind: "BuildTrain",
            slot: 0,
            source: "synthetic:github",
          },
        ],
        complete: false,
      },
      {
        acceptances: [],
        actions: [
          {
            at: 0,
            kind: "BuildTrain",
            members: [1, 2],
            slot: 0,
            source: "synthetic:private-log",
          },
        ],
        complete: true,
      },
    ]);

    const result = compare([expected], trace);
    expect(result.differences).toEqual([]);
    expect(result.provenance).toHaveLength(2);
    expect(result.status).toBe("pending");
  });

  it("distinguishes missing, extra, reordered cars and reordered actions", () => {
    const build = {
      cars: ["car-a", "car-b"],
      head: "base",
      kind: "BuildTrain",
    } as const;

    const trace = accepted("head");
    expect(
      compare([build, merge("head")], trace).differences.some(
        (difference) => difference.kind === "missing"
      )
    ).toBe(true);
    expect(
      compare([], trace).differences.some(
        (difference) => difference.kind === "extra"
      )
    ).toBe(true);

    const operatorBuild = {
      ...build,
      at: 0,
      cars: ["car-b", "car-a"],
      slot: 0,
      source: "synthetic:log",
    };

    expect(
      compare([build], { ...trace, actions: [operatorBuild] }).differences.some(
        (difference) => difference.kind === "different order"
      )
    ).toBe(true);
    expect(
      compare([build, merge("head")], {
        ...trace,
        actions: [
          { ...observed("head"), slot: 0 },
          { ...operatorBuild, cars: build.cars, slot: 1 },
        ],
      }).differences.some((difference) => difference.kind === "different order")
    ).toBe(true);
  });
});
