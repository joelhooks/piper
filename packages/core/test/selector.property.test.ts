import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import * as Arbitrary from "effect/Arbitrary";

import type { Candidate, Car } from "../src/domain.js";
import type { Plan } from "../src/plan.js";
import { isEligible, isLone, MAX_CARS, selectCars } from "../src/policy.js";
import { ciOn, input } from "./fixtures.js";

const entry = Schema.Struct({
  checked: Schema.Boolean,
  current: Schema.Boolean,
  dependency: Schema.Boolean,
  eligible: Schema.Boolean,
  file: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 })),
  labeled: Schema.Boolean,
  landed: Schema.Boolean,
  planned: Schema.Boolean,
  priority: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: -3 })),
});

const entries = Arbitrary.array(Arbitrary.schema(entry), { maxLength: 24 });

const cap = Arbitrary.schema(
  Schema.Int.check(Schema.isBetween({ maximum: 24, minimum: 0 }))
);

const rules = input(1);

const boardsFrom = (pool: readonly Candidate[]) => (candidate: Candidate) =>
  isEligible(candidate, rules, isLone(pool));

const scenario = (generated: readonly (typeof entry.Type)[]) => {
  const nodes = generated.map((value, index) => {
    const node = {
      files: [`src/unit-${value.file}.ts`],
      id: `node-${index}`,
      priority: value.priority,
    };

    return value.planned ? { ...node, pr: 100 + index } : node;
  });

  const plan: Plan = {
    edges: generated.flatMap((value, index) =>
      value.dependency && index > 0
        ? [{ after: `node-${index}`, before: `node-${index - 1}` }]
        : []
    ),
    nodes,
  };

  const pool: readonly Candidate[] = generated
    .flatMap((value, index) => {
      const headSha = `head-${index}`;

      const candidate: Candidate = {
        checks: ciOn(headSha, value.checked ? "green" : "red"),
        headSha,
        labels: value.labeled ? ["train"] : [],
        number: 100 + index,
        operatorReviewed: value.eligible,
        owner: "contributor/example",
        upToDate: value.current,
      };

      return [
        candidate,
        {
          ...candidate,
          checks: ciOn(`later-${index}`, value.checked ? "green" : "pending"),
          headSha: `later-${index}`,
          operatorReviewed: !value.eligible,
        },
      ];
    })
    .toReversed();

  return {
    landed: new Set(
      generated.flatMap((value, index) =>
        value.landed ? [`node-${index}`] : []
      )
    ),
    plan,
    pool,
  };
};

const legacy = (
  pool: readonly Candidate[],
  maxCars: number
): readonly Car[] => {
  const seen = new Set<number>();
  const cars: Car[] = [];

  for (const candidate of pool) {
    if (cars.length >= Math.min(maxCars, MAX_CARS)) {
      break;
    }

    if (!seen.has(candidate.number) && boardsFrom(pool)(candidate)) {
      seen.add(candidate.number);
      cars.push({
        headSha: candidate.headSha,
        number: candidate.number,
        owner: candidate.owner,
      });
    }
  }

  return cars;
};

describe("plan-aware selection", () => {
  it.prop(
    "no plan and empty plans are exactly the legacy selector, including duplicate candidates",
    { generated: entries, maxCars: cap },
    ({ generated, maxCars }) => {
      const { pool, landed } = scenario(generated);
      const expected = legacy(pool, maxCars);

      expect(selectCars(pool, maxCars, rules)).toEqual(expected);
      expect(
        selectCars(pool, maxCars, rules, { edges: [], nodes: [] }, landed)
      ).toEqual(expected);
    }
  );

  it.prop(
    "only ready eligible nodes board, never a file conflict, never above the cap",
    { generated: entries, maxCars: cap },
    ({ generated, maxCars }) => {
      const { plan, pool, landed } = scenario(generated);
      const selected = selectCars(pool, maxCars, rules, plan, landed);

      expect(selected.length).toBeLessThanOrEqual(Math.min(maxCars, MAX_CARS));
      expect(new Set(selected.map((car) => car.number)).size).toBe(
        selected.length
      );

      const selectedNodes = plan.nodes.filter((node) =>
        selected.some((car) => car.number === node.pr)
      );

      for (const car of selected) {
        expect(
          pool.some(
            (candidate) =>
              candidate.number === car.number &&
              candidate.headSha === car.headSha &&
              boardsFrom(pool)(candidate)
          )
        ).toBe(true);
      }

      for (const node of selectedNodes) {
        expect(landed.has(node.id)).toBe(false);

        for (const edge of plan.edges.filter(
          (dependency) => dependency.after === node.id
        )) {
          expect(landed.has(edge.before)).toBe(true);
        }

        for (const other of selectedNodes.filter(
          (peer) => peer.id !== node.id
        )) {
          expect(
            (node.files ?? []).some((file) =>
              (other.files ?? []).includes(file)
            )
          ).toBe(false);
        }
      }

      const priorities = selected.map(
        (car) =>
          plan.nodes.find((node) => node.pr === car.number)?.priority ?? 0
      );

      expect(priorities).toEqual(priorities.toSorted((a, b) => a - b));
    },
    { arbitrary: { runs: 400 } }
  );

  it.prop(
    "no edges or files preserves priority then eligible operator order and fills the cap",
    {
      length: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 24, minimum: 0 }))
      ),
      maxCars: cap,
      priority: Arbitrary.schema(entry.fields.priority),
    },
    ({ length, maxCars, priority }) => {
      const { plan, pool } = scenario(
        Array.from({ length }, (_, index) => ({
          checked: true,
          current: true,
          dependency: false,
          eligible: true,
          file: 0,
          labeled: true,
          landed: false,
          planned: index % 3 !== 0,
          priority: (priority + index) % 3,
        }))
      );

      const independent = {
        edges: [],
        nodes: plan.nodes.map(({ files: _files, ...node }) => node),
      };

      const expected = pool
        .filter(boardsFrom(pool))
        .filter(
          (candidate, index, eligible) =>
            eligible.findIndex((other) => other.number === candidate.number) ===
            index
        )
        .map(({ headSha, number, owner }) => ({ headSha, number, owner }))
        .toSorted(
          (a, b) =>
            (plan.nodes.find((node) => node.pr === a.number)?.priority ?? 0) -
            (plan.nodes.find((node) => node.pr === b.number)?.priority ?? 0)
        )
        .slice(0, Math.min(maxCars, MAX_CARS));

      expect(selectCars(pool, maxCars, rules, independent)).toEqual(expected);
    }
  );

  it.prop(
    "a generated prerequisite chain advances only from explicit landed facts, never from boarding or absence",
    {
      length: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 24, minimum: 2 }))
      ),
      prefix: cap,
    },
    ({ length, prefix }) => {
      const { pool, plan } = scenario(
        Array.from({ length }, () => ({
          checked: true,
          current: true,
          dependency: true,
          eligible: true,
          file: 0,
          labeled: true,
          landed: false,
          planned: true,
          priority: 0,
        }))
      );

      const chain = {
        ...plan,
        nodes: plan.nodes.map(({ files: _files, ...node }) => node),
      };

      const count = prefix % (length + 1);

      const landed = new Set(
        Array.from({ length: count }, (_, index) => `node-${index}`)
      );

      const selected = selectCars(pool, 12, rules, chain, landed);

      expect(selected.map((car) => car.number)).toEqual(
        count < length ? [100 + count] : []
      );
      expect(
        selectCars(
          pool.filter((candidate) => candidate.number !== 100 + count),
          12,
          rules,
          chain,
          landed
        )
      ).toEqual([]);
    }
  );

  it.prop(
    "every generated shared-file group boards exactly one priority winner per departure",
    {
      file: Arbitrary.schema(entry.fields.file),
      length: Arbitrary.schema(
        Schema.Int.check(Schema.isBetween({ maximum: 24, minimum: 2 }))
      ),
      priority: Arbitrary.schema(entry.fields.priority),
    },
    ({ length, priority, file }) => {
      const { plan, pool } = scenario(
        Array.from({ length }, (_, index) => ({
          checked: true,
          current: true,
          dependency: false,
          eligible: true,
          file,
          labeled: true,
          landed: false,
          planned: true,
          priority: (priority + index) % 3,
        }))
      );

      let waiting = pool;

      const expected = pool
        .filter(boardsFrom(pool))
        .toSorted(
          (a, b) =>
            (plan.nodes.find((node) => node.pr === a.number)?.priority ?? 0) -
            (plan.nodes.find((node) => node.pr === b.number)?.priority ?? 0)
        );

      for (const winner of expected) {
        const selected = selectCars(waiting, 12, rules, plan);

        expect(selected).toEqual([
          {
            headSha: winner.headSha,
            number: winner.number,
            owner: winner.owner,
          },
        ]);
        waiting = waiting.filter(
          (candidate) => candidate.number !== winner.number
        );
      }
    }
  );

  it("holds downstream work until an explicit landing, and holds file conflicts for the next train", () => {
    const generated = Array.from({ length: 3 }, () => ({
      checked: true,
      current: true,
      dependency: false,
      eligible: true,
      file: 0,
      labeled: true,
      landed: false,
      planned: true,
      priority: 0,
    }));

    const { plan, pool } = scenario(generated);
    const chained = { ...plan, edges: [{ after: "node-1", before: "node-0" }] };

    expect(
      selectCars(pool, 12, rules, chained).map((car) => car.number)
    ).toEqual([102]);
    expect(
      selectCars(
        pool.filter((car) => car.number !== 102),
        12,
        rules,
        chained
      ).map((car) => car.number)
    ).toEqual([100]);
    expect(
      selectCars(pool, 12, rules, chained, new Set(["node-0", "node-2"])).map(
        (car) => car.number
      )
    ).toEqual([101]);
    expect(
      selectCars(pool, 12, rules, {
        edges: [],
        nodes: [{ id: "absent", pr: 999 }],
      })
    ).toEqual(legacy(pool, 12));
  });
});
