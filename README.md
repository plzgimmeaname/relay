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
- **22 built-in CLI configs** — agy, claude, kilo, freebuff, qwen, junie, opencode, aider,
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
| `/forget [cli]`        | clear credit / cooldown marks                            |
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

21 checks against fake CLIs: failover on quota, native resume vs digest import,
text-dialect inlining, AGENTS.md block replacement, pinning, cooldown vs hard
marks, cross-directory references, protocol classification from real `--help`
output, the connect wizard, interruption, and missing binaries.
