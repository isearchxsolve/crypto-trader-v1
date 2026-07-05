# Server Risk TDD Hardening Spec

## Why
The platform already has a working multi-process runtime, but the most safety-critical trade admission logic is concentrated in `server/routes.ts` and has already suffered a real circuit-breaker bypass. To push the trader forward responsibly, the first enhancement phase needs deterministic server-side risk policy with thorough automated tests before deeper strategy expansion.

## What Changes
- Extract buy-admission risk decisions from `server/routes.ts` into dedicated server-side policy modules.
- Add thorough automated tests for circuit-breaker decisions, token safety vetoes, and exposure or spend guardrails.
- Wire the existing server flow to use the tested policy helpers without changing the platform's external startup flow.
- Preserve existing runtime behavior where it is already correct, while making regressions easier to detect.

## Impact
- Affected specs: trade admission safety, server-side risk evaluation, test-driven development baseline
- Affected code: `server/routes.ts`, new risk policy modules under `server/`, server test files, existing engine startup validation spec

## ADDED Requirements
### Requirement: Deterministic Risk Policy Module
The system SHALL provide server-side risk policy helpers for trade admission decisions that can be evaluated without live RPC, wallet, or HTTP dependencies.

#### Scenario: Circuit breaker blocks trading
- **WHEN** the effective daily loss, drawdown, market crash flag, or cooldown state exceeds the configured limits
- **THEN** the risk policy returns `canTrade = false`
- **AND** the returned reason identifies the blocking condition

#### Scenario: Exposure guard blocks unsafe entry
- **WHEN** a candidate entry would exceed configured exposure or minimum safe-balance constraints
- **THEN** the risk policy rejects the entry before a buy attempt is made
- **AND** the rejection reason is deterministic and testable

### Requirement: Token Safety Policy Module
The system SHALL provide a server-side token safety evaluator that can classify veto, caution, and pass outcomes from supplied safety inputs.

#### Scenario: Hard rug signal vetoes entry
- **WHEN** supplied token safety inputs indicate a hard-fail condition such as unacceptable RugCheck risk, unlocked LP veto, or extreme concentration risk
- **THEN** the safety policy returns a blocking result
- **AND** the returned reason identifies the veto source

#### Scenario: Fail-closed safety response
- **WHEN** critical safety inputs are missing or invalid for a condition that must fail closed
- **THEN** the safety policy blocks the entry instead of defaulting to a blind pass

### Requirement: Automated Risk Regression Coverage
The system SHALL include automated tests that cover the extracted risk and safety policies using table-driven or equivalent deterministic cases.

#### Scenario: Regression suite protects safety rails
- **WHEN** server-side risk logic changes in the future
- **THEN** the automated tests detect regressions in circuit-breaker, token safety, and exposure decisions before deployment

## MODIFIED Requirements
### Requirement: Trade Admission Flow
The server trade admission flow SHALL call extracted, tested policy helpers for circuit-breaker evaluation, token safety classification, and pre-buy exposure checks instead of keeping all decision logic inline inside `server/routes.ts`.

## REMOVED Requirements
