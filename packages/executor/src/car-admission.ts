import { Context, Data, Effect, Layer, Schema } from "effect";

import type { TrainAdmission } from "./train-domain.js";

export const CarAdmissionStatusSchema = Schema.Union([
  Schema.TaggedStruct("Admitted", {}),
  Schema.TaggedStruct("Revoked", { reason: Schema.NonEmptyString }),
  Schema.TaggedStruct("Unknown", { reason: Schema.NonEmptyString }),
]);

export type CarAdmissionStatus = typeof CarAdmissionStatusSchema.Type;

export const carAdmissionStatuses = Data.taggedEnum<CarAdmissionStatus>();

export interface CarAdmissionRequest {
  readonly car: TrainAdmission["car"];
  readonly repo: string;
  readonly train: number;
}

const admitted = {
  check: (_request: CarAdmissionRequest) =>
    Effect.succeed(carAdmissionStatuses.Admitted()),
};

export const CarStillAdmitted = Context.Reference<{
  readonly check: (
    request: CarAdmissionRequest
  ) => Effect.Effect<CarAdmissionStatus>;
}>("piper-executor/CarStillAdmitted", { defaultValue: () => admitted });

export const CarStillAdmittedDefault = Layer.succeed(
  CarStillAdmitted,
  admitted
);
