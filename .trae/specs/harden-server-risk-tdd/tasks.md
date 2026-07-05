# Tasks
- [x] Task 1: Define the risk-policy extraction boundary from `server/routes.ts`.
  - [x] Identify the circuit-breaker inputs and outputs that can be turned into deterministic policy functions.
  - [x] Identify the pre-buy exposure and spend checks that should move into the risk policy.
  - [x] Identify the token safety decision inputs that should be evaluated without inline network calls.

- [ ] Task 2: Build automated tests first for the extracted risk and safety decisions.
  - [ ] Add tests for circuit-breaker outcomes covering market crash, daily loss, drawdown, and cooldown cases.
  - [ ] Add tests for exposure and spend guards covering over-allocation and unsafe balance usage.
  - [ ] Add tests for token safety outcomes covering hard veto, fail-closed, and pass cases.

- [ ] Task 3: Implement extracted server-side policy modules and connect them to the engine flow.
  - [ ] Create dedicated server policy modules for risk and token safety decisions.
  - [ ] Refactor `server/routes.ts` to use the extracted policy helpers in trade admission paths.
  - [ ] Keep the current startup flow and runtime interfaces compatible.

- [ ] Task 4: Run verification for the new TDD slice.
  - [ ] Run the relevant automated tests for the new policy modules.
  - [ ] Run `npm run check` to confirm the server still typechecks.
  - [ ] Confirm the existing full-engine startup validation remains conceptually compatible with the refactor.

- [ ] Task 5: Summarize the enhancement result and remaining next-phase opportunities.
  - [ ] Report what safety logic is now covered by deterministic tests.
  - [ ] Report what parts of `server/routes.ts` were reduced or isolated.
  - [ ] List the next highest-value follow-up areas after this TDD phase.

# Task Dependencies
- Task 2 depends on Task 1.
- Task 3 depends on Task 2.
- Task 4 depends on Task 3.
- Task 5 depends on Task 4.
