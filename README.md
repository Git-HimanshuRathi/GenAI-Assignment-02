# 🤖 AI Web Agent — Scaler Website Cloner

An interactive conversational CLI agent that uses AI reasoning to clone the [Scaler Academy](https://www.scaler.com) website. The agent operates in a structured **START → THINK → PLAN → TOOL → OBSERVE → OUTPUT** loop, breaking complex tasks into small steps, generating HTML/CSS/JS files, and opening the result in your browser.

> Built for **GenAI Assignment 02** — demonstrating agentic AI behavior with tool use, iterative reasoning, and real file-system output.

---

## 🎬 Demo

📺 **YouTube Demo**: [Watch the 2-3 minute walkthrough](#) *(link to be added)*

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **Conversational CLI** | Chat naturally in your terminal — ask the agent to build, modify, or explain |
| **Agentic Reasoning Loop** | Multi-step START → THINK → PLAN → TOOL → OBSERVE → OUTPUT cycle |
| **Real File Output** | Generates actual `.html`, `.css`, and `.js` files on disk |
| **Browser Launch** | Automatically opens the generated site in your default browser |
| **Scaler Clone** | Produces a visually faithful clone with Header, Hero Section, and Footer |
| **Persistent Context** | The conversation history persists across turns within a session |
| **Beautiful Terminal UI** | Color-coded steps with chalk, loading spinners with ora |

---

## 🏗️ Architecture

```
User Input
    │
    ▼
┌─────────────────────┐
│   System Prompt      │  (defines tools, rules, output format)
│   + Conversation     │
│     History          │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   GPT-4.1-mini      │  (reasoning engine)
│   JSON response      │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Agent Loop Parser   │  (parses step, routes to handler)
│                      │
│  START  → log        │
│  THINK  → log        │
│  PLAN   → log        │
│  TOOL   → execute    │ ──→ writeFile / readFile / executeCommand
│  OBSERVE← result     │       openInBrowser / listFiles
│  OUTPUT → display    │
└─────────────────────┘
```

### Tools Available

| Tool | Description |
|------|-------------|
| `writeFile(filePath, content)` | Create/overwrite a file with given content |
| `readFile(filePath)` | Read file contents from disk |
| `executeCommand(cmd)` | Run any shell command |
| `openInBrowser(filePath)` | Open an HTML file in the default browser |
| `listFiles(dirPath)` | List directory contents |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** ≥ 18
- **OpenAI API Key** with access to `gpt-4.1-mini`

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/<your-username>/GenAI-Assignment-02.git
cd GenAI-Assignment-02

# 2. Install dependencies
npm install

# 3. Configure your API key
cp .env.example .env
# Edit .env and paste your OpenAI API key

# 4. Run the agent
npm start
```

### Usage

```
🧑 You → Clone the Scaler Academy website

🚀 START
──────────────────────────────────────────────────────────
The user wants me to clone the Scaler Academy website...

📋 PLAN
──────────────────────────────────────────────────────────
1) Create project folder  2) Create CSS  3) Create JS  4) Create HTML  5) Open in browser

🧠 THINK
──────────────────────────────────────────────────────────
Let me start by creating the project folder...

🔧 TOOL
──────────────────────────────────────────────────────────
Calling executeCommand({"cmd":"mkdir -p scaler-clone"})

👁  OBSERVE
──────────────────────────────────────────────────────────
Command executed successfully

... (agent continues step by step)

✅ OUTPUT
──────────────────────────────────────────────────────────
The Scaler website clone is ready! Opened in your browser.
```

Type `exit` to quit the agent.

---

## 📁 Project Structure

```
GenAI-Assignment-02/
├── index.js           # Main CLI agent (entry point)
├── package.json       # Project configuration & dependencies
├── .env.example       # Environment variable template
├── .gitignore         # Git ignore rules
├── README.md          # This file
└── scaler-clone/      # (generated at runtime by the agent)
    ├── index.html
    ├── styles.css
    └── script.js
```

---

## 🧠 How the Agent Loop Works

1. **User sends a message** → added to conversation history
2. **LLM reasons** → returns a JSON step (START, THINK, PLAN, TOOL, or OUTPUT)
3. **If TOOL** → the agent executes the tool locally and feeds the result back as an OBSERVE
4. **Loop continues** until the agent emits an OUTPUT step
5. **User is prompted** for the next instruction (persistent conversation)

The agent **never completes everything in one step** — it breaks tasks into incremental sub-tasks, demonstrating genuine agentic behavior with multi-step reasoning.

---

## 🎨 Generated Clone Features

The Scaler website clone includes:

- **Header**: Sticky navigation bar with Scaler logo, nav links (Masterclass, AI Labs, Alumni, etc.), and CTA buttons
- **Hero Section**: Bold headline with gradient text, subtitle, course cards with hover animations, and a gradient background
- **Why Scaler Section**: Feature cards with icons highlighting AI-Integrated Curriculum, AI-Powered Platform, Lifelong Learning, and Strong Foundations
- **Footer**: Multi-column layout with Explore Scaler, Resources, Others, Socials, and Trending Courses sections plus copyright

---

## 🛠️ Tech Stack

- **Runtime**: Node.js (ES Modules)
- **AI Model**: OpenAI GPT-4.1-mini
- **CLI UI**: Chalk (colors) + Ora (spinners)
- **Tools**: Node.js `fs`, `child_process`, `path`

---

## 📝 License

MIT

---

## 👤 Author

Built as part of the GenAI course — Assignment 02.
