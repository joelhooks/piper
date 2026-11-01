import { NodeServices } from "@effect/platform-node";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import { provideFreshArtifactStore } from "alchemy/Artifacts";
import { layerNonInteractive } from "alchemy/Interaction";
import { evalStack } from "alchemy/Stack";
import { inMemoryState } from "alchemy/State/InMemoryState";
import { ConfigProvider, Console, Effect, Layer } from "effect";

import stack from "../alchemy.run.js";

const dryRun = evalStack(
  stack,
  (compiled) =>
    Effect.succeed({
      bindings: Object.entries(compiled.bindings).map(([worker, bindings]) => ({
        names: bindings.map((binding) => binding.sid),
        worker,
      })),
      mode: "offline-declaration-dry-run",
      resources: Object.values(compiled.resources).map((resource) => ({
        id: resource.LogicalId,
        type: resource.Type,
      })),
      stack: compiled.name,
      stage: compiled.stage,
    }),
  { stage: "plan" }
).pipe(
  provideFreshArtifactStore,
  Effect.provide(
    Layer.mergeAll(
      inMemoryState(),
      layerNonInteractive(),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({ API_TOKEN: "offline-plan-fixture" })
      ),
      AlchemyContextLive.pipe(Layer.provide(NodeServices.layer)),
      NodeServices.layer
    )
  )
);

await Effect.runPromise(
  dryRun.pipe(
    Effect.flatMap((result) => Console.log(JSON.stringify(result, null, 2)))
  )
);
