import { Schema } from "effect";

import type { Intent, SoloIntent } from "./domain.js";

export const VocabularySchema = Schema.Struct({
  bisect: Schema.NonEmptyString,
  car: Schema.NonEmptyString,
  conflict: Schema.NonEmptyString,
  flake: Schema.NonEmptyString,
  invariants: Schema.NonEmptyString,
  judge: Schema.NonEmptyString,
  ledger: Schema.NonEmptyString,
  main: Schema.NonEmptyString,
  regression: Schema.NonEmptyString,
  solo: Schema.NonEmptyString,
  train: Schema.NonEmptyString,
});

export type Vocabulary = typeof VocabularySchema.Type;

export const rat: Vocabulary = {
  bisect: "gnaw",
  car: "rat",
  conflict: "rat king",
  flake: "whiff",
  invariants: "maze",
  judge: "whiskers",
  ledger: "hoard",
  main: "nest",
  regression: "stink",
  solo: "sniff test",
  train: "run",
};

export const plain: Vocabulary = {
  bisect: "bisect",
  car: "car",
  conflict: "conflict",
  flake: "flake",
  invariants: "invariants",
  judge: "judge",
  ledger: "ledger",
  main: "main",
  regression: "regression",
  solo: "solo",
  train: "train",
};

export const renderNotification = (
  intent: Intent | SoloIntent,
  vocabulary: Vocabulary = rat
): string | undefined => {
  if (intent.kind === "NotifyOperator") {
    return `${vocabulary.solo} #${intent.pr}: ${intent.outcome}.\n\n${intent.detail}`;
  }

  if (intent.kind !== "NotifyOwner") {
    return undefined;
  }

  if ("car" in intent) {
    const reasons = {
      conflict: vocabulary.conflict,
      culprit: vocabulary.bisect,
      "head-moved": "head moved",
    };

    const reason = reasons[intent.reason];

    return `${vocabulary.car} #${intent.car.number} left the ${vocabulary.train}: ${reason}.\n\n${intent.excerpt}`;
  }

  return `${vocabulary.solo} #${intent.pr}: ${vocabulary.regression}.\n\n${intent.excerpt}`;
};
