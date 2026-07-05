# Full Engine Startup Validation Spec

## Why
The trading platform depends on multiple coordinated processes, and a single broken startup step can make the whole engine unusable. We need a repeatable way to build the project and launch all required services with the exact command flow provided by the user.

## What Changes
- Define a full-engine startup validation workflow using the provided build and launch commands.
- Verify that the TypeScript server, ML server, and fast scanner can be started together from the workspace.
- Capture expected success signals and failure points for the combined startup flow.

## Impact
- Affected specs: full-engine startup validation, multi-process runtime verification
- Affected code: `package.json`, `server/index.ts`, `fast_scanner.cjs`, `solana_hybrid_sniper_ultra/ml_server.py`

## ADDED Requirements
### Requirement: Full Engine Startup Command
The system SHALL support a validation workflow that builds the project and launches the ML server, fast scanner, and TypeScript server using the user-provided command sequence.

#### Scenario: Successful full-engine startup
- **WHEN** the operator runs the approved startup sequence from the project root
- **THEN** the build step completes successfully
- **AND** the ML server process starts without an immediate runtime crash
- **AND** the fast scanner process starts without an immediate runtime crash
- **AND** the TypeScript server process starts without an immediate runtime crash

### Requirement: Startup Verification Signals
The system SHALL provide observable startup signals for each required process so the operator can confirm the engine is running.

#### Scenario: Operator verifies process health
- **WHEN** the startup sequence finishes launching the processes
- **THEN** logs or terminal output show that each process has entered its normal running state
- **AND** any startup failure is traceable to the specific process that failed

## MODIFIED Requirements
### Requirement: Runtime Validation
The runtime validation process SHALL include combined startup verification for the backend server, ML server, and fast scanner instead of validating only a single process in isolation.

## REMOVED Requirements
