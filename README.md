# relay

One session, every coding CLI. `relay` drives the agent CLIs you already have
(`agy` / Antigravity, `claude`, `kilo`, `freebuff`, `qwen`, `junie`, `opencode`) as one
continuous conversation: when one runs out of credits or hits rate limits, the next one in your
rotation picks up mid-task with the transcript in hand.

- **Shared transcript** — relay owns the session, not any single CLI. Each CLI
  that already saw the conversation resumes natively; one that joins later gets
  a digest of what happened.
- **Credit failover & pool balancing** — output is scanned for quota and auth signals.
  Choose between strict priority failover, round-robin credit pooling to prevent single-provider
  rate limits, or free-tier-first to burn zero-cost quotas before touching paid credits.
- **Auto-scan discovery** — 1-click detection of installed CLIs (`relay scan --auto`).
- **Relay Desktop Companion App** — sleek dark desktop application (`relay desktop`) with
  live credit meters, quota countdowns, interactive chat, and terminal streaming.
- **39 built-in CLI configs** — agy, claude, kilo, freebuff, qwen, junie, opencode, aider,
  cursor, copilot, ollama, gemini, openai, goose, cody, openhands, llm, sgpt, mentat, plandex,
  cline and more. `relay scan --auto` connects whichever are installed.
- **Multi-step prompts** — one prompt can dispatch agents to different CLIs/models in sequence,
  each step receiving the previous step's output:
  ```
  1. [@claude/sonnet] plan the refactor
  2. [@qwen] implement it
  3. [@freebuff] write tests
  ```
  Also accepted: `---` separated blocks starting with `@cli[:model]`, and `[claude] ... -> [qwen] ...`
  pipelines. Untagged steps are auto-assigned by role (plan/code/test/review).
- **AGENTS.md sync** — the last turns are mirrored into a machine block in
  `AGENTS.md`, so a CLI you start by hand can pick the work up too.
- **Sessions travel** — resume or reference any saved session, including ones
  recorded in a different directory.
- **Zero lock-in** — zero dependencies, clean JSON config, easy to add custom CLIs.

## Install

```sh
node bin/relay.js              # or: npm link   →  relay
```

Requires Node 18+. Nothing is installed into `~/.relay` until you run it.

## Quick start

```sh
relay                          # interactive shell
relay desktop                  # launch the desktop companion app
relay scan --auto              # auto-detect and connect installed CLIs
relay credits                  # view quota health & credit pool across all CLIs
relay strategy pool            # balance turns across CLIs to avoid rate limits
```

```sh
relay -p "explain this repo"   # one shot: print the answer, exit
relay -c                       # continue the last session in this directory
relay -r <id|#>                # resume any saved session
relay --yolo                   # let the CLIs act without permission prompts
relay backends                 # priority order and credit state
relay sessions --all           # every session, from every directory
relay connect <command>        # probe a CLI and print what relay detected
```

## Tag a CLI or model

Start a line with `@` to talk to one CLI directly. It works inside relay and from the shell
(`relay @claude …`).

| you type                    | what happens                                                     |
| --------------------------- | ---------------------------------------------------------------- |
| `@qwen explain this`        | one prompt to qwen; your current CLI stays as it was             |
| `@claude:opus …` · `@opus …`| same, on that model                                              |
| `@claude /cost`             | the CLI's slash command, sent exactly as typed                   |
| `@claude !mcp list`         | its terminal subcommand (shell: `relay @claude mcp list`)        |
| `@claude`                   | its own interactive UI, resuming this conversation when it can   |
| `@claude open /model`       | its UI, starting with that command                               |

A tag never fails over to a different CLI. Some slash commands only exist in a CLI's own UI
(headless mode rejects them); use `open` for those. What you do inside that UI is not copied into
relay's transcript — `relay native` and `relay import` can bring it in for claude, qwen and junie.
Opening a UI with a command is built in for claude, qwen, agy and junie. In the shell, one quoted
sentence is a prompt; other words go to the CLI as subcommands. `/run <cli> /cmd` does the same as
`@cli /cmd`. Tab completes tags, and slash commands relay has seen for that CLI.

## Skills

Import a skill once and use it with any model:

```sh
relay skill import ~/Downloads/my-skill          # a folder with SKILL.md (or a folder of them)
relay skill import ~/.claude/commands/review.md  # a slash-command file
relay skill import prompts/explain.toml          # a TOML command (description + prompt)
relay skill import .cursor/rules/style.mdc       # a Cursor rule
relay skill list                                 # also: show, export, remove
relay skill run review --cli qwen "the parser"
```

Inside relay: `/review the parser`, `@claude:opus /review the parser`, or `/skill import …`. If a
skill shares a name with a relay command, use `/skill use <name>`. If the tagged CLI already
advertises a command with that name, its own version runs.

Each import is converted to `~/.relay/skills/<name>/SKILL.md` plus its files, then reaches models
two ways:

- **Inside relay, on every connected CLI:** running a skill puts its instructions in the prompt,
  and every prompt lists the available skills so a model can pick one up unasked (that part needs
  a CLI that can read files).
- **Outside relay:** copies go to the folders CLIs load themselves — `~/.claude/skills`
  (claude, kilo), `~/.agents/skills` (qwen, kilo, agy), `~/.junie/skills` (junie). Skip this with
  `--no-export`. Relay only replaces or deletes copies it created; your own skills are left alone.

Conversion keeps the instructions as written. It cannot give a model a tool it lacks, so models are
told to use their closest equivalent, and weaker models may follow long skills less reliably.
Symbolic links are not imported, relay never runs a skill's `` !`command` `` lines itself, and
CLI-specific settings such as `allowed-tools` are dropped. A skill is instructions your agents will
follow, so read it (`relay skill show <name>`) before using one you didn't write.

## Desktop app

`relay desktop` accepts the same input as the shell: `@qwen …`, `@claude /cost`, imported skills
(`/name …`), `/skill list|show|use` and `/auto`. Anything that needs a terminal (a CLI's own UI or
subcommands, and importing or removing skills) tells you what to run instead. The local server only
answers the app itself: requests from other websites or non-local host names are refused.

## Auto mode

One command splits your instructions into tasks, gives each an agent, CLI and model, and runs them:

```sh
relay auto "fix the login crash, add a dark theme, then write tests for both"
relay auto --file tasks.md --dry-run      # show the plan, run nothing
relay auto --use claude,qwen "…"          # limit which CLIs may take tasks
relay auto --planner claude:opus "…"      # choose who does the split
relay auto --offline "…"                  # split locally, no planner call
```

Inside the shell: `/auto [--dry-run] [--offline] <instructions>`.

- **Split** — a connected CLI turns the instructions into tasks, each with a type (plan, research,
  review, code, debug, test, design, docs), a difficulty, whether it writes, and what it depends on.
  If no CLI can plan, a local keyword-based splitter does it. Prompts with `[@cli]` tags are kept as written.
- **Assign** — relay, not the planner, picks from CLIs that are connected, installed and ready.
  Hard tasks go to the strongest first; easy ones to free ones first. Chat-only CLIs get no
  writing tasks, and `pty` apps are used only if you name them.
- **Models** — difficulty picks a tier: claude `haiku`/`sonnet`/`opus`, agy flash-low/flash-high/hydrogen-high,
  junie effort low/medium/high. Other CLIs use their default model.
- **Run** — dependent tasks get earlier results. Read-only tasks run in parallel (3 by default);
  a writing task runs alone. A failed CLI hands the task to the next one with *that* CLI's model;
  a failed task skips only the tasks that depend on it. Read-only is enforced only by CLIs with
  permission modes; others are just told not to edit.
- **Agents** — each task is saved as `auto-<role>` (the next run reuses the name), so
  `relay agent auto-coder --attach` continues it.

Override the defaults in `~/.relay/config.json`:

```json
{
  "auto": {
    "planner": "claude:sonnet",
    "backends": ["claude", "qwen"],
    "routes": { "docs": ["qwen", "claude"] },
    "parallel": 2
  },
  "backends": {
    "qwen": { "models": { "light": "your-small-model", "standard": "your-model", "heavy": "your-big-model" } }
  }
}
```

## Supported CLIs Out of the Box

| CLI | Provider | Tier | Protocol | Resume Capability |
| --- | --- | --- | --- | --- |
| **agy** | Google Antigravity / Gemini | Free | `claude` (stream-json) | Native `--conversation` |
| **claude** | Anthropic Claude Code | Paid | `claude` (stream-json) | Native `--resume` |
| **kilo** | Kilo Code | Free | `text` / `pty` | Digest in prompt |
| **freebuff**| Freebuff AI | Free | `text` / `pty` | Digest in prompt |
| **qwen** | Qwen Code | Free | `claude` (stream-json) | Native `--resume` |
| **junie** | JetBrains Junie | Paid | `junie` (json-stream) | Native `--session-id` |
| **opencode**| OpenCode | Free | `text` / `pty` | Digest in prompt |

| **aider** | Aider AI Pair | Paid | `text` / `pty` | Digest in prompt |
| **cursor** | Cursor CLI | Paid | `text` / `pty` | Digest in prompt |
| **copilot** | GitHub Copilot | Paid | `text` / `pty` | Digest in prompt |
| **ollama** | Ollama (Local) | Free | `text` / `pty` | Digest in prompt |
| **gemini** | Google Gemini CLI | Free | `text` / `pty` | Digest in prompt |
| **openai** | OpenAI CLI | Paid | `text` / `pty` | Digest in prompt |
| **goose** | Goose Developer Agent | Free | `text` / `pty` | Digest in prompt |
| **cody** | Sourcegraph Cody | Paid | `text` / `pty` | Digest in prompt |
| **openhands** | OpenHands | Free | `text` / `pty` | Digest in prompt |
| **llm** | Simon Willison LLM | Free | `text` / `pty` | Digest in prompt |
| **sgpt** | Shell GPT | Paid | `text` / `pty` | Digest in prompt |
| **mentat** | Mentat AI | Free | `text` / `pty` | Digest in prompt |
| **plandex** | Plandex | Free | `text` / `pty` | Digest in prompt |
| **cline** | Cline CLI | Free | `text` / `pty` | Digest in prompt |
| **amazon-q** | Amazon Q Developer | Free | `text` / `pty` | Digest in prompt |
| **windsurf** | Windsurf (Codeium) | Paid | `text` / `pty` | Digest in prompt |
| **continue** | Continue.dev | Free | `text` / `pty` | Digest in prompt |
| **tabby** | Tabby (self-hosted) | Free | `text` / `pty` | Digest in prompt |
| **codeium** | Codeium | Free | `text` / `pty` | Digest in prompt |
| **amp** | Amp (Sourcegraph) | Paid | `text` / `pty` | Digest in prompt |
| **pi** | Pi (Inflection) | Free | `text` / `pty` | Digest in prompt |
| **crush** | Charm Crush | Free | `text` / `pty` | Digest in prompt |
| **mods** | Charm Mods | Free | `text` / `pty` | Digest in prompt |
| **fabric** | Fabric AI | Free | `text` / `pty` | Digest in prompt |
| **aichat** | AIChat | Free | `text` / `pty` | Digest in prompt |
| **gptscript** | GPTScript | Paid | `text` / `pty` | Digest in prompt |
| **ai-shell** | AI Shell | Free | `text` / `pty` | Digest in prompt |
| **chatblade** | Chatblade | Free | `text` / `pty` | Digest in prompt |
| **replit** | Replit AI | Free | `text` / `pty` | Digest in prompt |
| **devin** | Devin | Paid | `text` / `pty` | Digest in prompt |
| **tabnine** | Tabnine Chat | Free | `text` / `pty` | Digest in prompt |
| **github-copilot-cli** | GitHub Copilot CLI | Paid | `text` / `pty` | Digest in prompt |

## Credit Strategies

- **`priority`** (default) — strictly asks your favorite CLI first; fails over only when credits expire.
- **`pool`** — distributes turns round-robin / least-recently-used across all ready CLIs so you never hit hourly or daily limits on any single provider.
- **`free-first`** — burns free tiers (`agy`, `freebuff`, `kilo`, `qwen`, `opencode`) first, reserving premium credits (`claude`, `junie`) for fallbacks.

Change anytime via:
```sh
relay strategy pool
# or inside relay TUI:
/strategy free-first
```

## Commands

| inside relay           | does                                                     |
| ---------------------- | -------------------------------------------------------- |
| `<prompt>`             | send to the current CLI                                  |
| `/auto <instructions>` | split into tasks, assign agents + models, run them       |
| `@cli[:model] …`       | ask one CLI, or use its commands                         |
| `/skill …`             | import and manage skills                                 |
| `/credits`             | live credit pool health, countdowns, and stats           |
| `/strategy [name]`     | switch routing: priority, pool, free-first               |
| `/scan [--auto]`       | scan system for AI CLIs and connect them                 |
| `/status`              | session, backends, credit state, AGENTS.md               |
| `/priority [a b c]`    | show or set the failover order                           |
| `/use <cli>`           | pin a CLI for the following turns                        |
| `/backends`            | every connected CLI and its state                        |
| `/connect [command]`   | guided wizard: probe a CLI, pick its protocol, save it    |
| `/commands [cli]`      | slash commands relay has seen, from all CLIs             |
| `/run <cli> /cmd`      | run a CLI-native command verbatim on that CLI            |
| `/sync`                | write the progress block into AGENTS.md                  |
| `/note <text>`         | pin a durable note into every future prompt              |
| `/sessions [--all]`    | saved sessions, here or everywhere                       |
| `/resume [id\|#]`      | continue a saved session                                 |
| `/ref <id\|#\|name>`   | keep a past session in context (read-only)               |
| `/refs` · `/unref <id>`| list or drop references                                  |
| `/retry`               | re-run the last prompt                                   |
| `/forget [cli\|all]`   | clear credit / cooldown marks                            |
| `/clear`               | start a fresh session here                               |

## Adding your own CLI

`/connect` reads `--help`, then *probes* the CLI with one tiny request, because
help text lies. It reports what it can do — native resume, shared instructions,
how it signals being out of credits — and only saves after you confirm.

Protocols relay speaks, in descending capability:

- **claude** — stream-json in and out (`qwen`, `claude`, and compatible forks)
- **junie** — JetBrains `json-stream`, `--task=`, `--session-id=`, `--ide-guidelines=`
- **text** — plain `-p` and stdout; everything still works, context just travels
  inside the prompt

The same backends can be declared in `~/.relay/config.json`:

```json
{
  "order": ["qwen", "claude", "junie"],
  "digestWindow": 40,
  "backends": {
    "mycli": {
      "command": "mycli",
      "dialect": "text",
      "quota": ["credits depleted"],
      "protocol": { "args": ["-p", "--format", "stream-json"], "resumeArgs": [] }
    }
  }
}
```

`relay init` writes a fully commented starter config.

## Tests

```sh
npm test
```

57 checks, mostly against fake CLIs: failover on quota, native resume vs digest import,
text-dialect inlining, AGENTS.md block replacement, pinning, cooldown vs hard
marks, cross-directory references, protocol classification from real `--help`
output, the connect wizard, interruption, missing binaries, auto mode, tags, skills and the desktop server. The terminal-screen
(`pty`) and probe checks depend on timing and can occasionally time out.
