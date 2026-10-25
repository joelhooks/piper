export type JobKind = "poll" | "rerun" | "build";

export type Fault = "none" | "fail" | "die";

export interface JobPlan {
  readonly fault: Fault;
  readonly kind: JobKind;
  readonly slot: number;
}

export interface RunPlan {
  readonly appendFail: number;
  readonly jobs: readonly JobPlan[];
  readonly postFail: number;
  readonly readFails: boolean;
}

export type Fact =
  | { readonly tag: "claimed"; readonly slot: number }
  | {
      readonly error: string | null;
      readonly events: readonly string[];
      readonly slot: number;
      readonly status: "done" | "failed" | "recorded-would-do";
      readonly tag: "settled";
    }
  | { readonly tag: "delivering"; readonly slot: number }
  | { readonly tag: "delivered"; readonly slot: number };

export type Trace =
  | {
      readonly error: string | null;
      readonly step: "state";
      readonly value: "recovering" | "draining" | "done" | "error";
    }
  | { readonly fact: Fact; readonly step: "append" }
  | {
      readonly events: readonly string[];
      readonly slot: number;
      readonly step: "post";
    }
  | { readonly step: "read" };

export type Rule =
  | "recovered-interrupted"
  | "recovery-stopped"
  | "delivered"
  | "delivery-ambiguous"
  | "delivery-skipped"
  | "read-refused"
  | "claim-skipped"
  | "executed"
  | "execution-failed"
  | "crashed"
  | "storage-stopped"
  | "drained";

export const RULES: readonly Rule[] = [
  "recovered-interrupted",
  "recovery-stopped",
  "delivered",
  "delivery-ambiguous",
  "delivery-skipped",
  "read-refused",
  "claim-skipped",
  "executed",
  "execution-failed",
  "crashed",
  "storage-stopped",
  "drained",
];

export const INTERRUPTED =
  "interrupted: Execution was interrupted; reconcile provider state manually, never replay this intent";

export const READ_REFUSAL = "provider: synthetic read refusal";

export const OUTBOX_REFUSAL = "transport: synthetic outbox read refusal";

export const appendRefusal = (index: number) =>
  `storage: synthetic append ${index} refusal`;

export const postRefusal = (index: number) =>
  `transport: synthetic post ${index} refusal`;

type Settled = Extract<Fact, { readonly tag: "settled" }>;

const outcomeOf = (job: JobPlan): Settled => {
  if (job.fault === "fail") {
    return {
      error: READ_REFUSAL,
      events: job.kind === "build" ? ["buildFailed"] : [],
      slot: job.slot,
      status: "failed",
      tag: "settled",
    };
  }

  return job.kind === "poll"
    ? {
        error: null,
        events: ["checks"],
        slot: job.slot,
        status: "done",
        tag: "settled",
      }
    : {
        error: null,
        events: [],
        slot: job.slot,
        status: "recorded-would-do",
        tag: "settled",
      };
};

interface Stop {
  readonly error: string | null;
  readonly value: "done" | "error";
}

export const modelRun = (journal: readonly Fact[], plan: RunPlan) => {
  const facts = [...journal];
  const trace: Trace[] = [];
  const rules: Rule[] = [];
  const counts = { appends: 0, posts: 0 };

  const append = (fact: Fact): Stop | null => {
    const index = counts.appends;
    counts.appends += 1;

    if (index === plan.appendFail) {
      rules.push("storage-stopped");

      return { error: appendRefusal(index), value: "done" };
    }

    facts.push(fact);
    trace.push({ fact, step: "append" });

    return null;
  };

  const has = (slot: number, tags: readonly Fact["tag"][]) =>
    facts.some((fact) => fact.slot === slot && tags.includes(fact.tag));

  const post = (fact: Settled): Stop | null => {
    const index = counts.posts;
    counts.posts += 1;

    if (index === plan.postFail) {
      rules.push("delivery-ambiguous");

      return { error: postRefusal(index), value: "done" };
    }

    trace.push({ events: fact.events, slot: fact.slot, step: "post" });

    return null;
  };

  const deliver = (): Stop | null => {
    const snapshot = [...facts];

    for (const fact of snapshot) {
      if (fact.tag !== "settled" || fact.events.length === 0) {
        continue;
      }

      if (has(fact.slot, ["delivering", "delivered"])) {
        rules.push("delivery-skipped");
        continue;
      }

      const stop =
        append({ slot: fact.slot, tag: "delivering" }) ??
        post(fact) ??
        append({ slot: fact.slot, tag: "delivered" });

      if (stop !== null) {
        return stop;
      }

      rules.push("delivered");
    }

    return null;
  };

  const recover = (): Stop | null => {
    const snapshot = [...facts];

    for (const fact of snapshot) {
      if (fact.tag === "claimed" && !has(fact.slot, ["settled"])) {
        const stop = append({
          error: INTERRUPTED,
          events: [],
          slot: fact.slot,
          status: "failed",
          tag: "settled",
        });

        if (stop !== null) {
          rules.push("recovery-stopped");

          return stop;
        }

        rules.push("recovered-interrupted");
      }
    }

    return null;
  };

  const execute = (job: JobPlan): Stop | null => {
    const claim = append({ slot: job.slot, tag: "claimed" });

    if (claim !== null) {
      return claim;
    }

    if (job.fault === "die") {
      rules.push("crashed");

      return { error: null, value: "error" };
    }

    const stop = append(outcomeOf(job));

    if (stop !== null) {
      return stop;
    }

    rules.push(job.fault === "fail" ? "execution-failed" : "executed");

    return deliver();
  };

  const drain = (): Stop | null => {
    const delivered = deliver();

    if (delivered !== null) {
      return delivered;
    }

    trace.push({ step: "read" });

    if (plan.readFails) {
      rules.push("read-refused");

      return { error: OUTBOX_REFUSAL, value: "done" };
    }

    for (const job of plan.jobs) {
      if (has(job.slot, ["claimed"])) {
        rules.push("claim-skipped");
        continue;
      }

      const stop = execute(job);

      if (stop !== null) {
        return stop;
      }
    }

    rules.push("drained");

    return null;
  };

  const finish = (stop: Stop) => {
    trace.push({ error: stop.error, step: "state", value: stop.value });

    return { facts, rules, trace };
  };

  trace.push({ error: null, step: "state", value: "recovering" });
  const recovered = recover();

  if (recovered !== null) {
    return finish(recovered);
  }

  trace.push({ error: null, step: "state", value: "draining" });

  return finish(drain() ?? { error: null, value: "done" });
};
