import { expect } from "@effect/vitest";
import { Predicate } from "effect";

import type { CheckRun, Intent, TrainEvent } from "../src/domain.js";
import type { TrainSnapshot } from "../src/host.js";
import { alarmAt, stateName } from "../src/host.js";

const greenByOracle = (head: string, checks: readonly CheckRun[]) => {
  const runs = checks.filter(
    (run) => run.headSha === head && run.name !== "branch-current"
  );

  return (
    runs.length > 0 &&
    runs.every(
      (run) =>
        run.status === "completed" &&
        ["success", "neutral", "skipped"].includes(run.conclusion ?? "")
    )
  );
};

const buildsOf = (intents: readonly Intent[]) =>
  intents.filter(
    (intent): intent is Extract<Intent, { kind: "BuildTrain" }> =>
      intent.kind === "BuildTrain"
  );

const REBUILDS_ON_MAIN =
  /^(?:building|testing\.|landing\.awaitingGo|bisecting\.)/u;

export class Rules {
  readonly posted: TrainEvent[] = [];
  readonly trail: string[] = [];
  readonly cap: number;
  bisectFrom: number | undefined;
  bisects = 0;
  landed = 0;
  rebuilt = 0;
  widest = 0;

  constructor(maxCars: number) {
    this.cap = maxCars;
  }

  check(before: TrainSnapshot, event: TrainEvent, after: TrainSnapshot) {
    this.posted.push(event);
    this.trail.push(
      `${event.type} ${stateName(before)} -> ${stateName(after)}`
    );
    this.outbox(before, event, after);
    this.capacity(before, event, after);
    Rules.planSelection(before, event, after);
    this.timeoutRetry(before, event, after);
    this.mergeSafety(before, event, after);
    this.landingSafety(before, event, after);
    this.bisectStart(before, event, after);
    this.bisectReset(before, event, after);
    this.bisectProgress(before, event, after);
    this.mainRebuild(before, event, after);
    Rules.mergingMain(before, event, after);
    Rules.alarmDeadline(before, event, after);
    Rules.dueTick(before, event, after);
    Rules.conflictHandBack(before, event, after);
    Rules.headMovedHandBack(before, event, after);
  }

  static headMovedHandBack(
    before: TrainSnapshot,
    event: TrainEvent,
    after: TrainSnapshot
  ) {
    if (event.type !== "carHeadMoved") {
      return;
    }

    const car = before.context.cars.find((entry) => entry.number === event.pr);

    if (
      car === undefined ||
      car.headSha !== event.admittedHead ||
      event.actualHead === event.admittedHead
    ) {
      expect({ ...after.context, sync: before.context.sync }).toEqual(
        before.context
      );

      return;
    }

    const fresh = after.context.intents.slice(before.context.intents.length);

    if (before.context.intents.some((intent) => intent.kind === "Merge")) {
      expect(stateName(after)).toBe("abandoned");
      expect(fresh.filter((intent) => intent.kind === "BuildTrain")).toEqual(
        []
      );

      return;
    }

    const remaining = before.context.cars.filter(
      (entry) => entry.number !== event.pr
    );

    expect(after.context.cars).toEqual(remaining);
    expect(
      fresh
        .filter((intent) => intent.kind === "NotifyOwner")
        .map((intent) => intent.car)
    ).toEqual([car]);

    if (remaining.length === 0) {
      expect(stateName(after)).toBe("abandoned");
    } else {
      expect(stateName(after)).toBe("building");
      expect(buildsOf(fresh).map((intent) => intent.cars)).toEqual([remaining]);
      expect(after.context.head).toBeUndefined();
      expect(after.context.go).toBeUndefined();
      expect(after.context.checks).toEqual([]);
    }
  }

  static conflictHandBack(
    before: TrainSnapshot,
    event: TrainEvent,
    after: TrainSnapshot
  ) {
    const { build } = before.context;

    if (
      event.type !== "built" ||
      build?.id !== event.buildId ||
      !["building", "bisecting.building"].includes(stateName(before))
    ) {
      return;
    }

    const expected = build.cars.filter(
      (car) =>
        event.conflicted.includes(car.number) ||
        !event.merged.includes(car.number)
    );

    const fresh = after.context.intents.slice(before.context.intents.length);

    expect(
      fresh
        .filter((intent) => intent.kind === "NotifyOwner")
        .map((intent) => intent.car.number)
    ).toEqual(expected.map((car) => car.number));

    for (const car of expected) {
      expect(after.context.cars.map((entry) => entry.number)).not.toContain(
        car.number
      );
      expect(fresh).toContainEqual(
        expect.objectContaining({
          car,
          kind: "NotifyOwner",
          reason: "conflict",
        })
      );
    }
  }
  outbox(before: TrainSnapshot, event: TrainEvent, after: TrainSnapshot) {
    expect(
      after.context.intents.slice(0, before.context.intents.length)
    ).toEqual(before.context.intents);

    expect(after.context.cars.length).toBeLessThanOrEqual(this.cap);
  }

  capacity(before: TrainSnapshot, event: TrainEvent, after: TrainSnapshot) {
    const fresh = after.context.intents.slice(before.context.intents.length);

    for (const intent of fresh) {
      if (intent.kind === "BuildTrain" || intent.kind === "OpenTrainPr") {
        expect(intent.cars.length).toBeGreaterThan(0);
        expect(intent.cars.length).toBeLessThanOrEqual(this.cap);
        this.widest = Math.max(this.widest, intent.cars.length);
      }
    }
  }

  static planSelection(
    before: TrainSnapshot,
    event: TrainEvent,
    after: TrainSnapshot
  ) {
    const { plan, landed } = before.context;

    if (
      event.type !== "depart" ||
      stateName(before) !== "collecting" ||
      plan === undefined
    ) {
      return;
    }

    const selected = plan.nodes.filter((node) =>
      after.context.cars.some((car) => car.number === node.pr)
    );

    for (const node of selected) {
      expect(landed).not.toContain(node.id);

      for (const edge of plan.edges.filter(
        (dependency) => dependency.after === node.id
      )) {
        expect(landed).toContain(edge.before);
      }

      for (const other of selected.filter((peer) => peer.id !== node.id)) {
        expect(
          (node.files ?? []).some((file) => (other.files ?? []).includes(file))
        ).toBe(false);
      }
    }
  }

  timeoutRetry(before: TrainSnapshot, event: TrainEvent, after: TrainSnapshot) {
    const fresh = after.context.intents.slice(before.context.intents.length);

    if (fresh.some((intent) => intent.kind === "RerunChecks")) {
      expect(event.type).toBe("ranked");
      expect(
        event.type === "ranked" &&
          before.context.cars.every((car) =>
            event.ranks.some(
              (rank) =>
                rank.pr === car.number &&
                Predicate.isNumber(rank.p) &&
                rank.p < 0.2
            )
          ),
        this.trail.join("\n")
      ).toBe(true);
    }
  }

  mergeSafety(before: TrainSnapshot, event: TrainEvent, after: TrainSnapshot) {
    const fresh = after.context.intents.slice(before.context.intents.length);

    for (const merge of fresh.filter((intent) => intent.kind === "Merge")) {
      const head = merge.matchHead;

      const lastChecks = this.posted.findLast(
        (posted) => posted.type === "checks" && posted.head === head
      );

      const lastBuilt = this.posted.findLast(
        (posted) => posted.type === "built" && posted.head === head
      );

      const build = buildsOf(after.context.intents).find(
        (intent) =>
          lastBuilt?.type === "built" && intent.buildId === lastBuilt.buildId
      );

      expect(
        event.type === "go" && event.head === head,
        this.trail.join("\n")
      ).toBe(true);
      expect(fresh[fresh.indexOf(merge) - 1]).toMatchObject({
        kind: "MarkReady",
        pr: merge.pr,
      });
      expect(head).toBe(after.context.head);
      expect(
        lastChecks?.type === "checks" && greenByOracle(head, lastChecks.checks),
        this.trail.join("\n")
      ).toBe(true);
      expect(build?.purpose).toBe("train");
    }
  }

  landingSafety(
    before: TrainSnapshot,
    event: TrainEvent,
    after: TrainSnapshot
  ) {
    const was = stateName(before);
    const now = stateName(after);

    if (now === "landed" && was !== "landed") {
      this.landed += 1;
      expect(event.type).toBe("merged");
      expect(
        after.context.intents.some(
          (intent) =>
            intent.kind === "Merge" &&
            intent.matchHead === after.context.merged?.head
        )
      ).toBe(true);
    }
  }

  bisectStart(before: TrainSnapshot, event: TrainEvent, after: TrainSnapshot) {
    const was = stateName(before);
    const now = stateName(after);

    if (was !== "testing.triaging" && now === "testing.triaging") {
      this.bisectFrom = before.context.cars.length;
    }
  }

  bisectReset(before: TrainSnapshot, event: TrainEvent, after: TrainSnapshot) {
    const was = stateName(before);
    const now = stateName(after);

    if (
      this.bisectFrom !== undefined &&
      (event.type === "abandon" ||
        event.type === "buildFailed" ||
        now === "testing.polling" ||
        (event.type === "mainMoved" && was === "testing.triaging"))
    ) {
      this.bisectFrom = undefined;
    }
  }

  bisectProgress(
    before: TrainSnapshot,
    event: TrainEvent,
    after: TrainSnapshot
  ) {
    const was = stateName(before);
    const now = stateName(after);

    if (
      this.bisectFrom !== undefined &&
      (was.startsWith("bisecting.") || was === "testing.triaging") &&
      (now === "building" || now === "abandoned")
    ) {
      this.bisects += 1;
      expect(after.context.cars.length).toBeLessThan(this.bisectFrom);
      this.bisectFrom = undefined;
    }
  }

  mainRebuild(before: TrainSnapshot, event: TrainEvent, after: TrainSnapshot) {
    const was = stateName(before);
    const now = stateName(after);
    const fresh = after.context.intents.slice(before.context.intents.length);

    if (
      event.type === "mainMoved" &&
      event.main !== before.context.main &&
      REBUILDS_ON_MAIN.test(was)
    ) {
      this.rebuilt += 1;
      expect(now).toMatch(/^(?:building|bisecting\.building)$/u);
      expect(buildsOf(fresh).map((build) => build.base)).toEqual([event.main]);
    }
  }

  static mergingMain(
    before: TrainSnapshot,
    event: TrainEvent,
    after: TrainSnapshot
  ) {
    const was = stateName(before);
    const now = stateName(after);

    if (event.type === "mainMoved" && was === "landing.merging") {
      expect(now).toBe("landing.merging");
      expect(after.context.main).toBe(event.main);
    }
  }

  static alarmDeadline(
    before: TrainSnapshot,
    event: TrainEvent,
    after: TrainSnapshot
  ) {
    const now = stateName(after);

    const alarm = alarmAt(after);

    if (now === "testing.polling" || now === "bisecting.testing") {
      expect(alarm).toBeDefined();
    } else {
      expect(alarm).toBeUndefined();
    }
  }

  static dueTick(
    before: TrainSnapshot,
    event: TrainEvent,
    after: TrainSnapshot
  ) {
    const was = stateName(before);
    const now = stateName(after);
    const fresh = after.context.intents.slice(before.context.intents.length);
    const alarm = alarmAt(after);
    const due = alarmAt(before);

    if (event.type === "tick" && due !== undefined && event.at >= due) {
      expect(fresh.length > 0 || now !== was).toBe(true);
      expect(alarm === undefined || alarm > event.at).toBe(true);
    }
  }
}
