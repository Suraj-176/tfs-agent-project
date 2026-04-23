# TFS Agent Hub User Guide

Welcome to the **TFS Agent Hub**, a production-grade multi-agent platform designed to automate the heavy lifting of Software Development Life Cycles (SDLC) within Azure DevOps (TFS).

---

## 🚀 Quick Start Flow

Every agent in the Hub follows a consistent **4-stage workflow**:

1.  **Select Agent**: Choose the specialist agent for your specific task (Tasking, Testing, Bug Reporting, or Dashboards).
2.  **Configure**: Fill in the specialized form. Agents often support both manual text input and bulk file uploads.
3.  **Execute**: Click `Execute Agent`. The platform orchestrates between your chosen **AI Provider** (Gemini, OpenAI, Azure) and your **TFS Server**.
4.  **Review & Action**: Inspect the structured output. You can often refine the result via chat or directly upload/sync it to TFS.

---

## 🛠️ Essential Setup

Before running any agent, you **must** configure the two core modules in the header:

### 1. TFS Server Configuration
*   **Base URL**: Your TFS collection URL (e.g., `http://tfs:8080/tfs/DefaultCollection`).
*   **Authentication**:
    *   **PAT Token**: Recommended for modern TFS/Azure DevOps instances.
    *   **Username/Password**: Supported for on-premise NTLM authentication.
*   **Project Name**: The target project (e.g., "TruDocs").

### 2. AI Provider Configuration
*   **Provider**: Choose between Google Gemini, OpenAI, Azure OpenAI, or Anthropic.
*   **API Key**: Your personal or enterprise key.
*   **Advanced (Azure)**: Requires Endpoint, Deployment Name, and API Version.

---

## 🤖 Specialist Agents

### Agent 1: TFS Task Agent (The Decomposer)
Automates the creation and management of Task work items.

*   **Bulk Mode (Excel/CSV)**:
    *   Upload an Excel file containing your daily or sprint tasks.
    *   **Smart Parsing**: Supports "Dual-Header" (Resource name followed by tasks), standard tables, and a "Heuristic" mode that guesses columns if your template is non-standard.
    *   **Identity Resolution**: Automatically maps email addresses or names from your Excel to valid TFS identities.
    *   **Duplication Check**: Prevents creating the same task twice by checking the Title, Date, and Assignee.
*   **Create Mode (Requirement → Tasks)**:
    *   Provide a raw requirement; the AI decomposes it into 3-5 actionable subtasks with effort estimates (XS to XL).
*   **Update Mode**:
    *   Provide a Work Item ID; the AI suggests enhancements, clearer descriptions, and missing subtasks.

### Agent 2: Test Case Agent (The Designer)
Generates high-quality, structured QA test cases.

*   **Inputs**: TFS User Story ID (fetches details automatically), manual requirement text, and optional SOP (Standard Operating Procedure) context.
*   **Modes**:
    *   **Functional**: Deep logic and boundary value analysis.
    *   **UI/UX**: Focuses on look, feel, and interface interactions.
    *   **Both**: A comprehensive suite covering both aspects.
*   **Output**: A structured 3-column grid (Title, Step Action, Expected Result).
*   **Integration**: Seamlessly hands over output to the **Self-Healing Engine** for final formatting.

### Agent 4: Bug & Feature Agent (The Documenter)
Converts "messy" defect notes into professional TFS work items.

*   **AI Analysis**: Paste a raw chat snippet or quick notes. The AI automatically extracts:
    *   **Title**: Concise and descriptive.
    *   **Repro Steps**: Clear, numbered steps to reproduce the issue.
    *   **Actual vs. Expected**: Clearly defined delta.
    *   **Triage**: Auto-suggests Severity (1-4) and Priority (1-4).
*   **Attachments**: Drag-and-drop screenshots. The agent uploads them to TFS and embeds them directly into the "Steps to Reproduce" field for maximum developer visibility.

### Agent 5: Dashboard Agent (The Strategist)
Generates an executive-level view of QA health.

*   **TFS Data**: Provide Query IDs for Bugs, Retesting, and User Stories.
*   **Excel Integration**: Supports specialized reports for Vertical Validation, Automation Coverage, and Performance.
*   **AI Director Mode**: When enabled, a "Senior Strategic QA Director" AI analyzes the raw charts and provides a narrative on **Strategic Risks** and **Roadmaps**.

---

## 🛡️ Agent 3: Self-Healing Engine

The Hub features a unique, autonomous **Code Reviewer & Self-Healing Agent** that works silently behind the scenes to ensure zero-error output across the platform.

*   **Global Quality Gate**: While most visible in Agent 2, this engine automatically validates and repairs outputs for **Agent 1 (Tasking)**, **Agent 2 (Testing)**, and **Agent 4 (Bugs)**.
*   **Agent 1 Support**: Ensures generated task descriptions are professional and that all mandatory TFS fields are correctly structured.
*   **Agent 2 Support**: Fixes malformed Markdown tables, ensuring the 3-column grid (Title | Step | Expected) is perfectly formatted for Excel and TFS exports.
*   **Agent 4 Support**: Performs a "sanity check" on reproduction steps and triage fields (Severity/Priority) to ensure data integrity before saving to TFS.
*   **Intelligent Repair**: Uses a two-stage repair process (Rule-Based + LLM-Powered) to restore data or formatting without human intervention.

---

## 💡 Pro Tips

*   **Logs Tab**: Check here for real-time feedback on API connectivity and AI reasoning.
*   **Identity Resolution**: For Agent 1, ensure your Excel "Assigned To" column uses emails or names matching your TFS directory.
*   **SOP Context**: For Agent 2, providing your project's SOP text significantly improves test case relevance.
*   **Iteration Paths**: Always verify your Iteration Path (e.g., `Project\Sprint 1`) to ensure items land in the correct backlog.
