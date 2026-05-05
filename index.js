import "dotenv/config";
import { OpenAI } from "openai";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import chalk from "chalk";
import ora from "ora";

// ──────────────────────────────────────────────
//  LLM Clients (OpenAI-compatible SDK)
//  Primary: Gemini   •  Fallback: Groq (auto-engages on persistent rate limits)
// ──────────────────────────────────────────────
const geminiClient = process.env.GEMINI_API_KEY
  ? new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    })
  : null;

const groqClient = process.env.GROQ_API_KEY
  ? new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1",
    })
  : null;

const PROVIDERS = {
  gemini: { client: geminiClient, model: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  groq:   { client: groqClient,   model: "llama-3.1-8b-instant", label: "Groq Llama 3.1 8B Instant" },
};

// Mutable session state — starts on Gemini, can flip to Groq on persistent failures.
let activeProvider = geminiClient ? "gemini" : "groq";

// ──────────────────────────────────────────────
//  Tool Implementations
// ──────────────────────────────────────────────

/**
 * Write content to a file on disk. Creates directories if needed.
 * @param {string} filePath - Relative or absolute file path
 * @param {string} content  - File content to write
 */
function writeFile(filePath, content) {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolvedPath, content, "utf-8");
  return `File written successfully to ${resolvedPath}`;
}

/**
 * Append content to a file on disk. Creates the file (and parent dirs) if missing.
 * Useful for building large files in chunks to avoid output-token truncation.
 * @param {string} filePath - Relative or absolute file path
 * @param {string} content  - Content to append
 */
function appendFile(filePath, content) {
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(resolvedPath, content, "utf-8");
  const totalSize = fs.statSync(resolvedPath).size;
  return `Appended ${content.length} chars to ${resolvedPath} (file is now ${totalSize} bytes)`;
}

/**
 * Read the contents of a file from disk.
 * @param {string} filePath - Relative or absolute file path
 */
function readFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return `Error: File not found at ${resolvedPath}`;
  }
  const content = fs.readFileSync(resolvedPath, "utf-8");
  return content;
}

/**
 * Execute a shell command and return its stdout.
 * @param {string} cmd - The shell command to execute
 */
function executeCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
      if (error) {
        resolve(`Error: ${error.message}\n${stderr}`);
      } else {
        resolve(stdout || stderr || "Command executed successfully (no output)");
      }
    });
  });
}

/**
 * Open a file in the default browser.
 * @param {string} filePath - Path to the HTML file
 */
function openInBrowser(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    return `Error: File not found at ${resolvedPath}`;
  }
  const cmd =
    process.platform === "darwin"
      ? `open "${resolvedPath}"`
      : process.platform === "win32"
        ? `start "${resolvedPath}"`
        : `xdg-open "${resolvedPath}"`;

  return new Promise((resolve) => {
    exec(cmd, (error) => {
      if (error) {
        resolve(`Error opening file: ${error.message}`);
      } else {
        resolve(`Opened ${resolvedPath} in the default browser.`);
      }
    });
  });
}

/**
 * List files and directories at a given path.
 * @param {string} dirPath - Directory path to list
 */
function listFiles(dirPath) {
  const resolvedPath = path.resolve(dirPath);
  if (!fs.existsSync(resolvedPath)) {
    return `Error: Directory not found at ${resolvedPath}`;
  }
  const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
  const result = entries.map((e) => (e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`));
  return result.join("\n") || "Empty directory";
}

// ──────────────────────────────────────────────
//  Tool Registry
// ──────────────────────────────────────────────
const TOOLS = {
  writeFile: writeFile,
  appendFile: appendFile,
  readFile: readFile,
  executeCommand: executeCommand,
  openInBrowser: openInBrowser,
  listFiles: listFiles,
};

// ──────────────────────────────────────────────
//  System Prompt
// ──────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are an expert AI Web Developer Agent that operates in a structured reasoning loop.
You follow the cycle: START → THINK → PLAN → TOOL → OBSERVE → (repeat) → OUTPUT

Your primary task is to help users clone the Scaler Academy website (https://www.scaler.com) by generating fully working HTML, CSS, and JavaScript files.

═══ TOOLS ═══
- writeFile({filePath, content})    — create/overwrite file (mkdir -p)
- appendFile({filePath, content})   — append to file. USE THIS to chunk large files.
- readFile({filePath})               — read file contents
- executeCommand({cmd})              — run shell command
- openInBrowser({filePath})          — open HTML in default browser
- listFiles({dirPath})               — list directory

═══ RULES ═══
1. Always respond with a single valid JSON object per message.
2. Each response performs AT MOST ONE tool call. Bundle all reasoning into the same response (see OUTPUT FORMAT) — do NOT emit standalone reasoning-only messages, they waste API calls.
3. After every TOOL call, WAIT for the OBSERVE result before issuing the next response.
4. Be efficient. Plan in your head, act with the tool. Aim to finish a clone in under 12 tool calls.
5. When creating a website clone, build it incrementally and CHUNK large files:
   a. mkdir the project folder
   b. writeFile styles.css with :root design tokens + reset + header styles
   c. appendFile styles.css with hero section styles
   d. appendFile styles.css with stats + course-card grid + features styles
   e. appendFile styles.css with testimonials + footer + responsive media queries
   f. writeFile script.js with all interactions
   g. writeFile index.html with the full semantic markup and real copy
   h. openInBrowser the index.html
   Each chunk should be a substantive block of CSS/HTML — aim for 80–200 lines of real, rendered content per chunk.

6. ABSOLUTE NO-PLACEHOLDER RULE: Every text element you write must contain real, rendered copy. NEVER write literal "...", "TODO", "Lorem ipsum", "Placeholder", empty strings, or single-character text inside visible elements like h1/h2/p/a/li/button. If you find yourself wanting to type "...", STOP and write actual content (a real headline, real button label, real link text). Write your OWN original copy in the spirit of an edtech homepage — do NOT copy scaler.com verbatim, but DO produce realistic, complete sentences and labels.

7. For the Scaler website clone, generate substantial, content-rich sections. Use the structural guidance below.

═══ SCALER CLONE — BLUEPRINT (sections top→bottom) ═══
Write your OWN original copy in the spirit of an edtech homepage. Do NOT reproduce scaler.com text.

HEADER  — sticky, white bg, ~72px. Logo (bold "Scaler") | nav: Courses, Academy, Neovarsity, For Business, Resources | "Login" link | filled CTA. Mobile hamburger toggles slide-in menu.

HERO    — full-width, ~650px, dark gradient bg, 2-col desktop / stacked mobile.
  · eyebrow pill, H1 clamp(36–64px) with gradient span, 2-line subheadline, two CTAs (filled + ghost), trust strip ("20K+ learners • 1:1 mentorship • Top hiring partners"), right col abstract gradient blob/cards.

STATS   — 4 cols, big number + label (learners, avg package, hiring partners, rating).

COURSES — 3-card grid (1 col mobile). Each: gradient accent, program name, duration tag, 2–3 outcome bullets, "Learn More →". Programs: Software Development, Data Science & ML, DevOps & Cloud. Hover lift.

WHY     — 3×2 icon grid. Themes: Live classes, 1:1 mentorship, Industry curriculum, Placement support, Peer community, Real projects.

TESTIMONIALS — 2–3 cards (quote, name, role/company, outcome metric like "150% hike"). Logo strip below.

FOOTER  — dark, 4 cols + bottom bar. Col1: logo + tagline + social SVGs (LinkedIn/X/YouTube/IG). Col2 Programs. Col3 Company. Col4 Resources. Bottom: © 2025 Scaler + Privacy/Terms.

═══ DESIGN SYSTEM ═══
:root tokens — --bg-dark:#0B0B1F; --bg-darker:#060614; --surface:#16213E; --primary:#4361EE; --primary-2:#3F37C9; --accent:#F72585; --accent-2:#7209B6; --text:#E8EAF1; --text-muted:#9aa0b4; --hero-gradient:linear-gradient(135deg,#0B0B1F,#1A0B3D 50%,#2C0E5C); --cta-gradient:linear-gradient(135deg,#4361EE,#7209B6).
Typography — Inter, system-ui sans; weights 400/500/600/700; H1 clamp(36px,5vw,64px); body 16px/1.6.
Spacing — 8px scale; container max-width 1200px, padding 24px.
Components — buttons radius 8px; cards radius 16px; shadow 0 8px 24px rgba(0,0,0,.12).
Motion — 250ms ease-out; IntersectionObserver fade-up on sections.
Responsive — breakpoints 768 / 1024. CSS Grid + Flexbox.

═══ QUALITY BAR ═══
- styles.css ≥ 300 lines across chunked appendFile calls.
- script.js: sticky-header shadow on scroll, mobile menu toggle, IntersectionObserver fade-ins, smooth-scroll anchors.
- index.html semantic (header/main/section/footer), real copy in every element: real nav labels, real H1 sentence, real subheadline, real button labels, real stat numbers, real course descriptions, real testimonial quotes/names, real footer link labels.
- ZERO ellipsis/TODO/Lorem-ipsum. If a section won't fit in one response, finish it with appendFile.

═══ OUTPUT FORMAT ═══
Each response is ONE JSON object. To minimize API calls, bundle your reasoning with your action in the SAME response:

{
  "step": "TOOL" | "OUTPUT",
  "reasoning": "string — your start/plan/think notes (multi-line ok). Required for every response.",
  "tool_name": "string  (TOOL step only)",
  "tool_args": {}       (TOOL step only),
  "content":   "string  (OUTPUT step only — final user-facing message)"
}

Do NOT emit standalone START/THINK/PLAN messages. Whatever you would have said in those steps goes into the 'reasoning' field of your next TOOL response. After the OBSERVE comes back, the next response again carries reasoning + the next TOOL call. End the task with a single step=OUTPUT response.

═══ EXAMPLE ═══
User: Clone the Scaler website

Response 1:
{
  "step": "TOOL",
  "reasoning": "User wants a Scaler clone. Plan: 1) make folder, 2) write styles.css, 3) write script.js, 4) write index.html, 5) open in browser. Starting with the folder.",
  "tool_name": "executeCommand",
  "tool_args": { "cmd": "mkdir -p scaler-clone" }
}
// (system returns OBSERVE: success)

Response 2:
{
  "step": "TOOL",
  "reasoning": "Folder ready. Writing the full stylesheet now — header sticky bar, dark hero gradient, course-card grid, dark footer, design tokens, mobile breakpoints.",
  "tool_name": "writeFile",
  "tool_args": { "filePath": "scaler-clone/styles.css", "content": "/* ... full css ... */" }
}
// ...continue until everything is written and opened, then:

Final response:
{
  "step": "OUTPUT",
  "reasoning": "All four files written and the page is open in the browser.",
  "content": "Your Scaler clone is ready at scaler-clone/index.html and has been opened in your browser."
}
`;

// ──────────────────────────────────────────────
//  CLI Interface Helpers
// ──────────────────────────────────────────────
const BANNER = `
${chalk.hex("#4361EE").bold("╔══════════════════════════════════════════════════════════════╗")}
${chalk.hex("#4361EE").bold("║")}  ${chalk.hex("#F72585").bold("🤖 AI Web Agent")} ${chalk.dim("— Scaler Website Cloner")}                    ${chalk.hex("#4361EE").bold("║")}
${chalk.hex("#4361EE").bold("║")}  ${chalk.dim("Multi-provider (Gemini / Groq)  •  Type")} ${chalk.cyan("'exit'")} ${chalk.dim("to quit")}      ${chalk.hex("#4361EE").bold("║")}
${chalk.hex("#4361EE").bold("╚══════════════════════════════════════════════════════════════╝")}
`;

function printStep(step, content) {
  const icons = {
    REASON: chalk.hex("#7209B6").bold("🧠 REASON"),
    TOOL: chalk.hex("#F72585").bold("🔧 TOOL "),
    OBSERVE: chalk.hex("#4CC9F0").bold("👁  OBSERVE"),
    OUTPUT: chalk.green.bold("✅ OUTPUT"),
  };

  const icon = icons[step] || chalk.white.bold(`❓ ${step}`);
  console.log(`\n${icon}`);
  console.log(chalk.dim("─".repeat(60)));

  if (step === "TOOL") {
    console.log(chalk.yellow(content));
  } else if (step === "OUTPUT") {
    console.log(chalk.green(content));
  } else if (step === "OBSERVE") {
    // Truncate long observations for display
    const display = content.length > 500 ? content.slice(0, 500) + "\n... (truncated)" : content;
    console.log(chalk.cyan(display));
  } else {
    console.log(chalk.white(content));
  }
}

// ──────────────────────────────────────────────
//  Agent Loop
// ──────────────────────────────────────────────
// Slim history-stored copy of an assistant message: drop heavy payloads so
// they don't get re-sent on every subsequent API call.
function slimForHistory(parsed) {
  if (parsed?.step === "TOOL" && (parsed?.tool_name === "writeFile" || parsed?.tool_name === "appendFile")) {
    const content = parsed?.tool_args?.content ?? "";
    const verb = parsed.tool_name === "appendFile" ? "appended" : "written";
    return {
      ...parsed,
      tool_args: {
        ...parsed.tool_args,
        content: `[omitted from history — ${content.length} chars ${verb}]`,
      },
    };
  }
  return parsed;
}

// Cap stored OBSERVE size so executeCommand/long stdout doesn't bloat history.
// readFile callers should be the rare case where the model needs the full body;
// we still cap but generously.
function slimObservation(toolName, resultStr) {
  const HARD_CAP = toolName === "readFile" ? 8000 : 1500;
  if (resultStr.length <= HARD_CAP) return resultStr;
  return resultStr.slice(0, HARD_CAP) + `\n... (truncated, ${resultStr.length - HARD_CAP} more chars)`;
}

// Sleep helper.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull retry-after seconds from Groq error shape if present.
function retryAfterSeconds(err) {
  const headerVal =
    err?.response?.headers?.get?.("retry-after") ??
    err?.headers?.["retry-after"] ??
    err?.headers?.get?.("retry-after");
  const n = Number(headerVal);
  if (Number.isFinite(n) && n > 0) return n;
  // Groq sometimes embeds "Please try again in 4.2s" in the message.
  const m = /try again in ([\d.]+)\s*s/i.exec(err?.message || "");
  if (m) return Math.ceil(parseFloat(m[1]));
  return null;
}

async function agentLoop(userMessage, conversationHistory) {
  conversationHistory.push({ role: "user", content: userMessage });

  let iterationCount = 0;
  const MAX_ITERATIONS = 25; // Lower ceiling — bundled reasoning means fewer hops.
  let consecutiveBackoffs = 0;

  while (iterationCount < MAX_ITERATIONS) {
    iterationCount++;
    const spinner = ora({ text: chalk.dim("Agent is thinking..."), color: "cyan" }).start();

    let response;
    try {
      const { client, model } = PROVIDERS[activeProvider];
      response = await client.chat.completions.create({
        model,
        messages: conversationHistory,
        temperature: 0.1,
        max_tokens: 8000,
        response_format: { type: "json_object" },
      });
      consecutiveBackoffs = 0;
    } catch (err) {
      spinner.stop();
      const status = err?.status ?? err?.response?.status;
      const isRateLimit = status === 429 || /rate.?limit/i.test(err?.message || "");
      const isTransient5xx = typeof status === "number" && status >= 500 && status < 600;
      const isRetryable = isRateLimit || isTransient5xx;
      const detail = (err?.error?.message || err?.message || "").toString().slice(0, 200);

      // Auto-fallback: if primary provider keeps refusing, swap to the other one.
      const otherProvider = activeProvider === "gemini" ? "groq" : "gemini";
      const canFallback = PROVIDERS[otherProvider]?.client && consecutiveBackoffs >= 2;
      if (isRetryable && canFallback) {
        console.log(
          chalk.cyan(
            `🔁 ${PROVIDERS[activeProvider].label} keeps refusing — switching to ${PROVIDERS[otherProvider].label} for the rest of this session.`
          )
        );
        if (detail) console.log(chalk.dim(`   reason: ${detail}`));
        activeProvider = otherProvider;
        consecutiveBackoffs = 0;
        iterationCount--;
        continue;
      }

      if (isRetryable && consecutiveBackoffs < 5) {
        consecutiveBackoffs++;
        const wait = (retryAfterSeconds(err) ?? Math.min(30, 2 ** consecutiveBackoffs)) * 1000;
        const label = isRateLimit ? "Rate limited" : `Server ${status} (overloaded)`;
        console.log(chalk.yellow(`⏳ ${label}. Waiting ${Math.round(wait / 1000)}s before retry (${consecutiveBackoffs}/5)…`));
        if (detail) console.log(chalk.dim(`   reason: ${detail}`));
        await sleep(wait);
        iterationCount--; // don't burn an iteration on a retry
        continue;
      }
      console.log(chalk.red(`\n❌ API Error: ${err.message}`));
      break;
    }

    spinner.stop();

    const content = response.choices[0].message.content;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      console.log(chalk.red("⚠ Failed to parse agent response. Retrying..."));
      conversationHistory.push({ role: "assistant", content });
      conversationHistory.push({
        role: "developer",
        content: JSON.stringify({
          step: "OBSERVE",
          content: "Your response was not valid JSON. Respond with a single valid JSON object per the required format.",
        }),
      });
      continue;
    }

    // Print bundled reasoning (if any) before printing the action.
    if (parsed.reasoning) printStep("REASON", parsed.reasoning);

    // Push a slimmed copy of the assistant message into history.
    conversationHistory.push({
      role: "assistant",
      content: JSON.stringify(slimForHistory(parsed)),
    });

    if (parsed.step === "TOOL") {
      const toolName = parsed.tool_name;
      const toolArgs = parsed.tool_args || {};
      printStep("TOOL", `Calling ${chalk.bold(toolName)}`);

      if (!TOOLS[toolName]) {
        const errMsg = `Tool '${toolName}' is not available. Available tools: ${Object.keys(TOOLS).join(", ")}`;
        printStep("OBSERVE", errMsg);
        conversationHistory.push({
          role: "developer",
          content: JSON.stringify({ step: "OBSERVE", content: errMsg }),
        });
        continue;
      }

      let result;
      try {
        if (toolName === "writeFile")           result = await TOOLS[toolName](toolArgs.filePath, toolArgs.content);
        else if (toolName === "appendFile")     result = await TOOLS[toolName](toolArgs.filePath, toolArgs.content);
        else if (toolName === "readFile")       result = await TOOLS[toolName](toolArgs.filePath);
        else if (toolName === "executeCommand") result = await TOOLS[toolName](toolArgs.cmd);
        else if (toolName === "openInBrowser")  result = await TOOLS[toolName](toolArgs.filePath);
        else if (toolName === "listFiles")      result = await TOOLS[toolName](toolArgs.dirPath);
      } catch (err) {
        result = `Error executing tool: ${err.message}`;
      }

      const resultStr = typeof result === "string" ? result : JSON.stringify(result);
      printStep("OBSERVE", resultStr);
      conversationHistory.push({
        role: "developer",
        content: JSON.stringify({ step: "OBSERVE", content: slimObservation(toolName, resultStr) }),
      });
    } else if (parsed.step === "OUTPUT") {
      printStep("OUTPUT", parsed.content);
      break;
    } else {
      // Stray START/THINK/PLAN — treat as reasoning-only and nudge the model forward.
      conversationHistory.push({
        role: "developer",
        content: JSON.stringify({
          step: "OBSERVE",
          content: "Reasoning-only responses are not allowed. Bundle reasoning into the next TOOL or OUTPUT response.",
        }),
      });
    }
  }

  if (iterationCount >= MAX_ITERATIONS) {
    console.log(chalk.yellow("\n⚠ Reached maximum iteration limit. Stopping agent loop."));
  }
}

// ──────────────────────────────────────────────
//  Main – Interactive CLI
// ──────────────────────────────────────────────
async function main() {
  console.clear();
  console.log(BANNER);

  // Check for at least one API key
  if (!geminiClient && !groqClient) {
    console.log(chalk.red("❌ No API key found. Set GEMINI_API_KEY and/or GROQ_API_KEY in .env"));
    console.log(chalk.dim("   Gemini: https://aistudio.google.com/apikey"));
    console.log(chalk.dim("   Groq:   https://console.groq.com"));
    process.exit(1);
  }
  console.log(chalk.dim(`🔌 Active provider: ${PROVIDERS[activeProvider].label}`));
  if (geminiClient && groqClient) {
    const fallback = activeProvider === "gemini" ? "groq" : "gemini";
    console.log(chalk.dim(`   Fallback ready: ${PROVIDERS[fallback].label} (auto-switches on persistent rate limits)`));
  }

  console.log(chalk.dim("💡 Try: \"Clone the Scaler Academy website\"\n"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Conversation history persists across turns
  const conversationHistory = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
    },
  ];

  const prompt = () => {
    rl.question(chalk.hex("#4361EE").bold("\n🧑 You → "), async (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        console.log(chalk.hex("#F72585")("\n👋 Goodbye! Happy coding.\n"));
        rl.close();
        process.exit(0);
      }

      await agentLoop(trimmed, conversationHistory);
      prompt(); // Ask for next input
    });
  };

  prompt();
}

main();
