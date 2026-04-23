# TFS Agent Hub — Enterprise Multi-Agent SDLC Platform

**TFS Agent Hub** is a production-grade automation platform built with **FastAPI** and **CrewAI**. It streamlines the Software Development Life Cycle (SDLC) by orchestrating specialized AI agents to automate task decomposition, test case generation, bug reporting, and executive reporting within **Azure DevOps (TFS)**.

---

## 🌟 Core Philosophy: "Multi-Agent Intelligence"

Unlike simple LLM wrappers, the Hub utilizes a **Multi-Agent Orchestration** pattern. Every primary output (tasks, test cases, bugs) is autonomously verified and "healed" by a specialized **Self-Healing Agent** before reaching the user, ensuring zero-error formatting and high data integrity.

---

## 🤖 The Agent Roster

### [Agent 1] TFS Task Agent (The Decomposer)
*   **Bulk Mode**: Smart parsing of non-standard Excel/CSV templates with heuristic column detection.
*   **Create Mode**: Decomposes high-level requirements into 3-5 actionable subtasks with effort estimation.
*   **Identity Resolution**: Automatically maps names and emails to valid TFS identities.

### [Agent 2] Test Case Generator (The Designer)
*   **Multi-Mode**: Supports Functional, UI/UX, or Hybrid testing strategies.
*   **Context Aware**: Incorporates project-specific SOPs and UI screenshots into test logic.
*   **Output**: Generates structured 3-column Markdown grids optimized for TFS/Excel.

### [Agent 3] Self-Healing Engine (The Quality Gate)
*   **Autonomous Correction**: Silently repairs malformed Markdown tables and missing columns.
*   **Enforcement**: Ensures all work items meet professional enterprise standards.
*   **Integration**: Actively monitors and fixes outputs from Agents 1, 2, and 4.

### [Agent 4] Bug & Feature Agent (The Documenter)
*   **Natural Language Parsing**: Converts raw chat snippets or "messy" notes into structured TFS bugs.
*   **Screenshot Orchestration**: Automatically uploads images to TFS and embeds them in reproduction steps.
*   **Triage Intelligence**: Auto-suggests Severity and Priority based on issue description.

### [Agent 5] QA Dashboard Agent (The Strategist)
*   **Data Aggregation**: Pulls live data from TFS Saved Queries and Excel validation reports.
*   **AI Director Mode**: Provides a high-level strategic narrative on risks, roadmaps, and confidence scores.

---

## 🛠️ Technical Stack

*   **Backend**: Python 3.10+, FastAPI (Asynchronous execution)
*   **Orchestration**: CrewAI (Role-playing collaborative agents)
*   **Frontend**: Modern Vanilla HTML5, CSS3, and JavaScript
*   **Integrations**: Azure DevOps (TFS) REST API, NTLM Authentication
*   **AI Providers**: Native support for Google Gemini, OpenAI, Azure OpenAI, and Anthropic

---

## 🚀 Quick Start

### 1. Environment Setup
```bash
# Clone the repository
git clone https://github.com/your-repo/tfs-agent-hub.git
cd tfs-agent-hub

# Install dependencies
pip install -r requirements.txt
```

### 2. Launch the Platform
```powershell
# Windows (handles venv and pip automatically)
.\start-backend.ps1
```

### 3. Configuration
1.  Open the UI at `http://localhost:8000`.
2.  Configure your **TFS Server** (PAT or Username/Password).
3.  Choose your **AI Provider** and enter your API key (Stored securely in session memory).

---

## 🔒 Security & Privacy

*   **Session-Based Config**: API keys and credentials are stored in your browser's local session storage. They are never saved to a database and are wiped when the tab is closed.
*   **PII Masking**: Agents are designed to focus on logic and structure, minimizing the transfer of sensitive data.
*   **Connectivity First**: The platform includes built-in connectivity testers for both TFS and AI providers.

---

## 📖 Documentation
For detailed usage instructions, "Pro Tips," and agent-specific workflows, refer to the [User Guide](./USER_GUIDE.md) or access it directly via the **📖 User Guide** button in the application header.

---

## 📄 License
MIT License - Developed for enterprise SDLC automation.
