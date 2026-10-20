import { fileURLToPath } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { TrainRecord } from "../src/train-domain.js";
import { admission } from "./train-fixture.js";

for (const namedBase of [false, true]) {
  it.effect(
    `CLI refuses ${namedBase ? "an unadmitted live repo" : "an unnamed base"} with compatible JSON and exit one`,
    () =>
      Effect.gen(function* cliRefusal() {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const directory = yield* fs.makeTempDirectoryScoped({
          prefix: "piper-train-cli-",
        });

        const input = {
          ...admission,
          baseBranch: namedBase ? admission.baseBranch : "",
          tokenCommand: `touch '${directory}/token-invoked'`,
        };

        yield* fs.writeFileString(
          `${directory}/admission.json`,
          JSON.stringify(input)
        );

        const child = yield* spawner.spawn(
          ChildProcess.make(
            fileURLToPath(new URL("../bin/piper-executor", import.meta.url)),
            ["train", `${directory}/admission.json`, `${directory}/state`],
            {
              env: { PIPER_LIVE_ADMITTED_REPO: "not-admitted" },
              extendEnv: true,
              stderr: "pipe",
              stdin: "ignore",
            }
          )
        );

        const output = yield* Stream.mkString(Stream.decodeText(child.stdout));
        expect(yield* child.exitCode).toBe(1);
        const lines = output.trim().split("\n");

        const records = yield* Effect.all(
          lines.map((line) =>
            Schema.decodeEffect(Schema.fromJsonString(TrainRecord))(line)
          )
        );

        expect(records).toHaveLength(2);
        const [stop, exit] = records;
        expect(stop).toMatchObject({
          harm: namedBase
            ? "writing to a repository the operator did not admit"
            : "building against an unnamed base",
          next: namedBase
            ? "set PIPER_LIVE_ADMITTED_REPO to the admitted repo"
            : "add baseBranch to the admission",
          writes: 0,
        });
        expect(exit).toEqual({
          exit: namedBase ? "live repo not admitted" : "invalid admission",
        });
        expect(output).toBe(
          yield* fs.readFileString(`${directory}/state/log.jsonl`)
        );
        expect(yield* fs.exists(`${directory}/token-invoked`)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer))
  );
}
