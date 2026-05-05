import "dotenv/config";
import { OpenAI } from "openai";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import chalk from "chalk";
import ora from "ora";

// ──────────────────────────────────────────────
//  Groq Client (OpenAI-compatible SDK)
// ──────────────────────────────────────────────
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

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

═══ TOOLS AVAILABLE ═══
1. writeFile(filePath, content) — Create or overwrite a file. Creates directories if needed.
   - tool_args: { "filePath": "string", "content": "string" }

2. appendFile(filePath, content) — Append to an existing file (creates it if missing).
   USE THIS to build large files in multiple chunks so a single response never has to carry all of styles.css or index.html at once. Example pattern:
     1) writeFile styles.css with the :root tokens + reset + header CSS
     2) appendFile styles.css with hero CSS
     3) appendFile styles.css with cards + features CSS
     4) appendFile styles.css with testimonials + footer + media queries
   - tool_args: { "filePath": "string", "content": "string" }

3. readFile(filePath) — Read the contents of an existing file.
   - tool_args: { "filePath": "string" }

4. executeCommand(cmd) — Execute a shell command (unix/mac).
   - tool_args: { "cmd": "string" }

5. openInBrowser(filePath) — Open an HTML file in the default browser.
   - tool_args: { "filePath": "string" }

6. listFiles(dirPath) — List files and directories at a path.
   - tool_args: { "dirPath": "string" }

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

═══ SCALER CLONE — STRUCTURAL BLUEPRINT ═══

Treat this as a scaffold to expand on. Write your own copy in the spirit of an edtech homepage — do NOT copy verbatim from scaler.com.

▸ HEADER (sticky, ~72px tall, white background, subtle bottom shadow on scroll)
  - Left: Scaler-style wordmark logo (use text "Scaler" with bold weight, or an inline SVG)
  - Center/Right nav links: "Courses", "Scaler Academy", "Scaler Neovarsity", "For Business", "Resources" (each with a small chevron suggesting a dropdown)
  - Right side CTAs: a "Login" text link + a primary filled button "Book a Free Trial" or "Apply Now"
  - Mobile: hamburger that toggles a slide-in menu (wire this in script.js)

▸ HERO SECTION (full-width, ~600–700px tall, dark gradient background)
  - Two-column layout on desktop (text left, illustration/graphic right), stacks on mobile
  - Eyebrow tag (small pill): e.g. "Transform Your Tech Career"
  - H1 headline (clamp 36px → 64px) with a gradient-highlighted span on a key word
  - Subheadline paragraph (~2 lines) describing outcomes — placement, mentorship, live classes
  - Two CTAs side-by-side: primary filled "Get Started" + ghost outline "Watch Demo"
  - Trust strip below CTAs: "20,000+ learners" • "1:1 mentorship" • "Top tech companies hiring"
  - Right column: floating cards / stats tiles / abstract gradient blob illustration (pure CSS)

▸ STATS / SOCIAL-PROOF STRIP (4 columns)
  - Big number + label pattern, e.g. "20K+ Learners", "₹35 LPA Avg Package", "1000+ Hiring Partners", "4.8/5 Rating"

▸ COURSE / PROGRAM CARDS GRID (3 cards on desktop, 1 on mobile)
  - Each card: gradient border or top accent, program name, duration tag, 2–3 bullet outcomes, "Learn More →" link
  - Suggested programs: "Software Development", "Data Science & ML", "DevOps & Cloud"
  - Subtle lift-on-hover (translateY -6px + box-shadow)

▸ "WHY SCALER" FEATURE GRID (2x3 or 3x2)
  - Icon + title + 1-line description per cell
  - Themes: Live classes, 1:1 mentorship, Industry curriculum, Placement support, Peer community, Real projects

▸ TESTIMONIAL SECTION
  - 2–3 cards with quote, learner name, role/company, outcome metric (e.g., "150% hike")
  - Optional company logo strip below ("Hired at: Google, Amazon, Microsoft, …" — render as styled text pills)

▸ FOOTER (dark background, ~4 columns + bottom bar)
  - Column 1: Logo + 1-line tagline + social icons (LinkedIn, Twitter/X, YouTube, Instagram) as inline SVGs
  - Column 2 "Programs": Scaler Academy, Data Science, DevOps, Neovarsity
  - Column 3 "Company": About, Careers, Press, Contact
  - Column 4 "Resources": Blog, Events, Community, Help Center
  - Bottom bar: © 2025 Scaler. All rights reserved. + small Privacy / Terms links

═══ DESIGN SYSTEM ═══
- Color tokens (declare as :root CSS variables):
  --bg-dark: #0B0B1F;  --bg-darker: #060614;  --surface: #16213E;
  --primary: #4361EE;  --primary-2: #3F37C9;
  --accent: #F72585;   --accent-2: #7209B6;
  --text: #E8EAF1;     --text-muted: #9aa0b4;
  --hero-gradient: linear-gradient(135deg, #0B0B1F 0%, #1A0B3D 50%, #2C0E5C 100%);
  --cta-gradient: linear-gradient(135deg, #4361EE 0%, #7209B6 100%);
- Typography: font stack "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"; weights 400/500/600/700; H1 clamp(36px, 5vw, 64px); body 16px/1.6.
- Spacing: 8px scale (8/16/24/32/48/64/96). Container max-width 1200px, side padding 24px.
- Components: rounded buttons (border-radius 8px), card radius 16px, soft shadows (0 8px 24px rgba(0,0,0,.12)).
- Motion: 250ms ease-out transitions; subtle fade-up on scroll for sections (use IntersectionObserver in script.js).
- Responsive: mobile breakpoint at 768px, tablet at 1024px. Use CSS Grid + Flexbox.

═══ FILE QUALITY BAR ═══
- styles.css should be 300+ lines spread across the chunked appendFile calls above.
- script.js should implement: sticky-header shadow on scroll, mobile menu toggle, IntersectionObserver fade-ins, smooth-scroll for anchor links.
- index.html should be semantic (header/main/section/footer), use proper heading hierarchy, and contain REAL copy for every visible element:
   * Real nav link labels (e.g., "Courses", "Programs", "Resources", "About")
   * A real H1 headline (a complete sentence, e.g., "Accelerate your tech career with live mentorship")
   * A real subheadline paragraph
   * Real button labels ("Get Started", "Watch Demo")
   * Real stat numbers and labels in the social-proof strip
   * Real course names + descriptions in the cards
   * Real testimonial quotes with names and roles
   * Real footer column headers and link labels
- ZERO ellipsis placeholders. ZERO empty elements. If you cannot fit a section's full content into one response, use appendFile to add the rest.

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
${chalk.hex("#4361EE").bold("║")}  ${chalk.dim("Powered by Llama 3.3 70B (Groq)  •  Type")} ${chalk.cyan("'exit'")} ${chalk.dim("to quit")} ${chalk.hex("#4361EE").bold("║")}
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
      response = await client.chat.completions.create({
        model: "llama-3.3-70b-versatile",
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
      if (isRateLimit && consecutiveBackoffs < 4) {
        consecutiveBackoffs++;
        const wait = (retryAfterSeconds(err) ?? Math.min(30, 2 ** consecutiveBackoffs)) * 1000;
        console.log(chalk.yellow(`⏳ Rate limited. Waiting ${Math.round(wait / 1000)}s before retry (${consecutiveBackoffs}/4)…`));
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

  // Check for API key
  if (!process.env.GROQ_API_KEY) {
    console.log(chalk.red("❌ GROQ_API_KEY not found in environment."));
    console.log(chalk.dim("   Create a .env file with: GROQ_API_KEY=your_key_here"));
    console.log(chalk.dim("   Get a free key at: https://console.groq.com"));
    process.exit(1);
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
