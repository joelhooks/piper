# Piper contribution rules

## Before every commit

Ask **"could this be more rat stack?"** Then apply the **uncomplect lens**. Neither question is optional. Record both answers in the commit review or delivery report. Act on the findings before committing.

For the rat-stack question:

- Keep effects in Effect and finite lifecycles in XState, started through `createEffectActor`.
- Check the pinned rat-stack source and its rules before changing the fence.
- Keep exact dependency pins, strict diagnostics, the fence, and the tests on.
- Fix code rather than adding exemptions or bypassing hooks.

For the uncomplect lens:

- Separate domain values, policy, lifecycle, effects, storage, and transport.
- Keep facts distinct from current decisions and projections.
- Define accidental errors out of existence with schemas and types.
- Delete unnecessary mechanisms. Do not add an abstraction unless it removes more complexity than it introduces.
- Name preserved behavior and deleted complexity in the report.

## Commands

- `pnpm install --frozen-lockfile`: install exact dependencies and prepare the compiler and hooks.
- `pnpm check`: typecheck, lint, verify the zero-exemption baseline, check formatting, and run tests.
- `pnpm test`: run the fixture and property suites.
- `pnpm fix`: intentionally apply lint and formatting changes; inspect the diff afterwards.

Node 24, pnpm 11.3.0, Effect 4.0.5, XState 6.0.0-alpha.70, `@xstate/effect` 1.0.0-alpha.9, TypeScript 7.0.2 with `@effect/tsgo` 0.54.0, and Vitest 5.0.5 are the stack contract. Do not migrate runtimes or relax pins as a side effect.

## Boundaries

`packages/core/src/domain.ts` owns schemas and public values. `policy.ts` owns pure policy. The train and solo machines own separate lifecycles. The host helpers own scoped actor execution and the mailbox barrier. Machines append intents and facts. They do no network, filesystem, or provider I/O. Provider adapters must remain outside core. `vocabulary.ts` owns display words and pure notification rendering. Only renderers receive a vocabulary; machines, policy, events, intents, and ledger facts keep plain domain values.

Read the installed Effect `AGENTS.md` and the pinned Effect and XState source before changing their integration. Expected errors are typed failures. Defects remain defects. Restore actors with `createEffectActor(machine, { snapshot })`. Never replace this with a pure-transition replay shortcut.

## Fence

- No prose comments in code. Put explanations in names, types, tests, documentation, or commits.
- The no-comments rule permits reasoned tool directives and one-line `SAFETY:` invariants, but the exemption ratchet permits no diagnostic suppression directives.
- Every type assertion needs a real invariant. Prefer precise types and boundary parsing instead.
- Anti-slop rules, `xstate-effect/no-inline-effect`, and `effect-tests/no-manual-effect-runtime-in-tests` are errors.
- Use `@effect/vitest` for Effect tests. Prefer generated properties and model traces over examples.
- Prove a new invariant test can fail by breaking the invariant temporarily, then restore the code.
- Lint debt may only shrink. The current baseline is zero directives outside vendored lint rules.
- Only test configs opt into the exact unstable module `effect/Arbitrary`. Child configs list exact unstable modules imported in their scope, including the Effect 4.0.5 platform modules and test-only `@effect/vitest`, following rat-stack's supported child-config contract. The worker plan has a separate config for its Node services. Production typechecks separately under the unchanged base diagnostic map. Never allow prefixes, copy severity maps into child configs, or ignore Effect warnings in the compiler exit code.
- Lefthook runs `pnpm check` and `pnpm test` before every commit. Never bypass it.
- Claude and Cursor blockers use `scripts/vcs-command-policy.js`. `prepare` links `tools/pi/git-interceptor` into the ignored local Pi extension directory.
- Changes that weaken lint, diagnostics, hook policy, or the ratchet need explicit owner approval.

## Public safety and source control

Keep fixtures synthetic. Do not add private records, credentials, customer identifiers, local infrastructure details, or imported repository history. Preserve existing work. Stage only this task's files. Do not stage injected local harness files.
