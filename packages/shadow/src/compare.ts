import type { ActionValues, OperatorAction, Trace } from "./domain.js";

export interface Difference {
  readonly kind:
    | "missing"
    | "extra"
    | "different head"
    | "different cars"
    | "different order"
    | "conflict";
  readonly expected: ActionValues | undefined;
  readonly observed: readonly OperatorAction[];
  readonly field: string;
}

export interface Comparison {
  readonly status: "match" | "pending" | "diff";
  readonly differences: readonly Difference[];
  readonly pending: readonly string[];
  readonly provenance: readonly OperatorAction[];
}

const fields = [
  "kind",
  "head",
  "cars",
  "members",
  "prs",
  "label",
  "mergeSha",
] as const;

type Field = (typeof fields)[number];

const equal = (left: ActionValues[Field], right: ActionValues[Field]) =>
  JSON.stringify(left) === JSON.stringify(right);

const mismatchKind = (
  field: Field,
  expected: ActionValues,
  observed: OperatorAction
): Difference["kind"] => {
  if (field === "head") {
    return "different head";
  }

  if (
    field === "cars" &&
    expected.cars !== undefined &&
    observed.cars !== undefined &&
    equal(expected.cars.toSorted(), observed.cars.toSorted())
  ) {
    return "different order";
  }

  return "different cars";
};

const conflicts = (group: readonly OperatorAction[]): Difference[] =>
  fields.flatMap((field) => {
    const supplied = group.filter((action) => action[field] !== undefined);
    const [first] = supplied;

    return first !== undefined &&
      supplied.some((action) => !equal(action[field], first[field]))
      ? [{ expected: undefined, field, kind: "conflict", observed: supplied }]
      : [];
  });

const compareFields = (
  action: ActionValues,
  group: readonly OperatorAction[],
  position: number
) => {
  const differences: Difference[] = [];
  const pending: string[] = [];

  for (const field of fields) {
    const value = action[field];

    if (value === undefined) {
      continue;
    }

    const supplied = group.filter((item) => item[field] !== undefined);

    if (supplied.length === 0) {
      pending.push(`slot ${position}: missing ${field} evidence`);
    }

    for (const observed of supplied) {
      if (!equal(value, observed[field])) {
        differences.push({
          expected: action,
          field,
          kind: mismatchKind(field, action, observed),
          observed: [observed],
        });
      }
    }
  }

  return { differences, pending };
};

const acceptancePending = (
  expected: readonly ActionValues[],
  trace: Trace
): string[] => {
  const merges = expected.filter((action) => action.kind === "Merge");
  const pending = trace.complete ? [] : ["operator history is incomplete"];

  if (merges.length === 0) {
    pending.push("no predicted merge");
  }

  for (const merge of merges) {
    if (
      !trace.actions.some(
        (action) =>
          action.kind === "Merge" &&
          action.head === merge.head &&
          action.mergeSha !== undefined
      )
    ) {
      pending.push(`no merge receipt at ${merge.head}`);
    }

    if (
      !trace.acceptances.some(
        (acceptance) =>
          acceptance.head === merge.head && acceptance.fact.nodes.length > 0
      )
    ) {
      pending.push(`no explicit operator acceptance at ${merge.head}`);
    }
  }

  return pending;
};

const comparisonStatus = (
  differences: readonly Difference[],
  pending: readonly string[]
): Comparison["status"] => {
  if (differences.length > 0) {
    return "diff";
  }

  return pending.length > 0 ? "pending" : "match";
};

const readyImpliedByMerge = (action: ActionValues, trace: Trace): boolean =>
  action.kind === "MarkReady" &&
  action.head !== undefined &&
  action.prs !== undefined &&
  !trace.actions.some(
    (item) =>
      item.kind === "MarkReady" &&
      (item.head === action.head || equal(item.prs, action.prs))
  ) &&
  trace.actions.some(
    (item) =>
      item.kind === "Merge" &&
      item.head === action.head &&
      equal(item.prs, action.prs)
  );

export const compare = (
  expected: readonly ActionValues[],
  trace: Trace
): Comparison => {
  const slots = [
    ...new Set(trace.actions.map((action) => action.slot)),
  ].toSorted((a, b) => a - b);

  const groups = slots.map((slot) =>
    trace.actions.filter((action) => action.slot === slot)
  );

  const differences: Difference[] = groups.flatMap(conflicts);
  const pending = acceptancePending(expected, trace);
  const used = new Set<number>();

  const comparable = expected.filter(
    (action) => !readyImpliedByMerge(action, trace)
  );

  for (const [index, action] of comparable.entries()) {
    const exact = groups.findIndex(
      (group, position) =>
        !used.has(position) &&
        group.some(
          (item) => item.kind === action.kind && item.head === action.head
        )
    );

    const position =
      exact === -1
        ? groups.findIndex(
            (group, groupIndex) =>
              !used.has(groupIndex) &&
              group.some((item) => item.kind === action.kind)
          )
        : exact;

    const group = groups[position];

    if (group === undefined) {
      differences.push({
        expected: action,
        field: "action",
        kind: "missing",
        observed: [],
      });
      continue;
    }

    used.add(position);

    if (position !== index) {
      differences.push({
        expected: action,
        field: "slot",
        kind: "different order",
        observed: group,
      });
    }

    const result = compareFields(action, group, position);
    differences.push(...result.differences);
    pending.push(...result.pending);
  }

  for (const [index, group] of groups.entries()) {
    if (!used.has(index)) {
      differences.push({
        expected: undefined,
        field: "action",
        kind: "extra",
        observed: group,
      });
    }
  }

  return {
    differences,
    pending,
    provenance: trace.actions,
    status: comparisonStatus(differences, pending),
  };
};
