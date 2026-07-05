# Tasks
- [x] Task 1: Review the startup prerequisites for the full engine run.
  - [x] Confirm the workspace build command and server entrypoint from `package.json`.
  - [x] Confirm the ML server path `solana_hybrid_sniper_ultra/ml_server.py` exists and is launchable.
  - [x] Confirm the fast scanner entry `fast_scanner.cjs` exists and is launchable.

- [x] Task 2: Execute the full engine startup sequence from the project root.
  - [x] Run `npm run build`.
  - [x] Start the ML server process with `python solana_hybrid_sniper_ultra/ml_server.py`.
  - [x] Start the fast scanner process with `node fast_scanner.cjs`.
  - [x] Start the TypeScript server with `npx cross-env NODE_ENV=development tsx server/index.ts`.

- [x] Task 3: Verify startup health for every required process.
  - [x] Check that the build completed successfully.
  - [x] Check that the ML server stays up without an immediate crash.
  - [x] Check that the fast scanner stays up without an immediate crash.
  - [x] Check that the TypeScript server stays up without an immediate crash.
  - [x] Record any missing dependency, port conflict, or runtime error blocking startup.

- [x] Task 4: Summarize the full engine test outcome for the user.
  - [x] Report whether the combined startup succeeded end-to-end.
  - [x] List the specific process that failed if the run is incomplete.
  - [x] Recommend the next fix only for the blockers observed during the run.

# Task Dependencies
- Task 2 depends on Task 1.
- Task 3 depends on Task 2.
- Task 4 depends on Task 3.
