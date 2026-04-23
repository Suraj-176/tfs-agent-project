# Gemini CLI Project Context: TFS Agent Hub

## Project Overview
TFS Agent Hub is a multi-agent automation platform built with **FastAPI** and **CrewAI**. It streamlines software development lifecycles by automating task decomposition, test case generation, and bug reporting within **Azure DevOps (TFS)**.

## Technical Stack
- **Backend:** Python 3.10+, FastAPI, CrewAI.
- **Frontend:** Vanilla HTML5, CSS3, and JavaScript (located in `frontend/`).
- **Integrations:** Azure DevOps (TFS) REST API via `requests`.
- **AI Orchestration:** Multi-provider support (Azure OpenAI, OpenAI, Gemini, Claude) managed via `backend/llm_config.py`.

## Engineering Standards
- **Interactive Review & Revert (Copilot-Style):** For any code modification:
    1. Show a clear, visual "Diff" block of the proposed changes before or immediately after applying them.
    2. Explicitly ask the user to confirm the change or if they want it reverted.
    3. Provide an interactive option in the chat or terminal to "Keep" or "Revert" the code.
- **Surgical Modifications:** When instructed to fix or focus on a specific agent (e.g., "Agent 4") or feature, target the change precisely. NEVER modify or impact unrelated code paths, architectural patterns, or other agents' logic unless explicitly required by the fix. Always ensure that the change is local to the requested scope.
- **Backup Protocol:** Before performing any large-scale refactoring or making "big changes" to a file, create a backup copy (e.g., `filename.bak` or `filename_backup_[timestamp].py`) to ensure zero-loss recovery.
- **Mandatory Review & Unit Testing:** After any code changes are completed, the agent MUST:
    1. Perform a thorough, manual-like review of **each and every file** that was modified.
    2. Execute (or create if missing) **unit tests** for the changed logic.
    3. If any issues, bugs, or regressions occur, the agent **MUST FIX THEM FIRST** before considering the task complete or asking for final confirmation.
- **Agent Pattern:** All agents must reside in `backend/agents/`. They should follow the established pattern of having a `create_[name]_agent` factory and an `execute_[name]` entry point.
- **TFS Utilities:** Avoid direct API calls to TFS in agent files. Use or extend `backend/tfs_tool.py` and `backend/tfs_upload.py`.
- **Output Validation:** All primary agent outputs (Tasks, Test Cases) MUST be passed through the **Code Reviewer Agent** (`code_reviewer_agent.py`) for formatting validation and "auto-healing" before being returned to the UI.
- **Frontend Consistency:** Keep the frontend lightweight (Vanilla JS). Use the `app.js` state management for handling agent execution progress.

## Skill Plan: Senior-Level Agent Lifecycle Management (10+ Years Exp Standard)
When extending the system with new agents or features, follow this production-grade workflow:

1.  **Phase 1: Deep Research & Architecture Review**
    *   **Context Discovery:** Analyze `backend/main.py` and `backend/llm_config.py`. Ensure the new agent aligns with the existing multi-provider architecture.
    *   **Dependency Audit:** Identify any new third-party libraries needed. Verify they are stable and compatible with Python 3.10+.
    *   **Security & PII Check:** Identify potential sensitive data handled by the agent. Plan for input sanitization and PII masking.

2.  **Phase 2: Implementation (The "Surgical & Robust" Method)**
    *   **Backup Protocol:** Mandatory backup of modified files (`cp file file.bak`).
    *   **Agent Logic (`backend/agents/`):**
        - **Modular Design:** Use the established factory pattern (`create_[name]_agent`).
        - **Robust Prompts:** Implement structured, versioned prompts in `backend/prompts_manager.py`. Prompts must include clear personas, few-shot examples, and strict output schemas.
        - **Error Handling:** Use `try-except-finally` blocks for all IO and AI operations. Implement exponential backoff for API retries.
        - **Telemetry:** Add detailed structured logging (`logger.info`, `logger.error`) with unique execution IDs for traceability.
    *   **Integration:**
        - **Registry:** Register the endpoint in `backend/main.py` using FastAPI's dependency injection for session management.
        - **Self-Heal Integration:** All agent outputs MUST pass through `execute_code_review` for auto-correction before delivery.

3.  **Phase 3: UI/UX & Frontend Consistency**
    *   **Component Sync:** Update `frontend/index.html` using the existing design system. Ensure new fields have clear labels, placeholders, and validation tooltips.
    *   **State Management:** Update `frontend/js/app.js` to handle real-time progress (`0-100%`) and robust error display for the new agent.

4.  **Phase 4: Validation & Quality Gates (The "Fix-First" Gate)**
    *   **Comprehensive File Review:** Review **each and every modified file** to ensure logical consistency and adherence to patterns.
    *   **Empirical Unit Testing:** Run the test suite in `tests/` and add new tests covering the specific changes.
        - **Happy Path:** Successful execution with standard input.
        - **Edge Cases:** Empty inputs, extremely long descriptions, and invalid tokens.
        - **Failure Modes:** Simulated API timeouts and TFS connectivity issues.
    *   **Mandatory Self-Correction:** If tests fail or issues are identified during review, **fix them immediately**. The task is only "Done" when all tests pass and the code is verified as bug-free.
    *   **Benchmarking:** Verify execution time and token consumption for efficiency.
    *   **Peer Review (Local):** Verify the agent's "auto-healing" loop correctly repairs at least 3 common formatting errors.

## Hooks
- **Pre-Modification Backup Hook:** BEFORE any tool-based modification (`replace`, `write_file`) that is considered a "big change" or refactor, the agent MUST take a manual backup of the file to ensure the user can revert immediately.
- **Change Validation Hook:** After executing a code change tool (like `replace` or `write_file`), pause to present the diff and wait for the user to confirm or request a revert before moving on to unrelated tasks.
- **Post-Implementation Review & Test Hook:** AFTER completing all code modifications in a task, the agent MUST perform a comprehensive review of all changed files and execute unit tests. All identified issues must be resolved before finalizing.
- **Senior Quality Gate Hook:** Before finalizing any new agent code, verify it includes:
    1. Robust logging with execution IDs.
    2. Input sanitization (no credentials or PII in logs).
    3. Proper retry logic for all external API calls.
    4. Integration with the `code_reviewer_agent` for self-healing.
- **Connectivity Check:** Before performing any TFS operation, the system should prompt or verify connectivity using the `/api/tfs/authenticate` logic.
- **LLM Configuration:** Always prioritize the session-based configuration provided by the frontend over hardcoded `.env` values during execution.
