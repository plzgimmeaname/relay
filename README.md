# relay

One session, every coding CLI. `relay` drives the agent CLIs you already have
(`qwen`, `claude`, `junie`, or anything that answers a prompt on stdout) as one
continuous conversation: when one runs out of credits, the next one in your
priority order picks up mid-task with the transcript in hand.

- **Shared transcript** — relay owns the session, not any single CLI. Each CLI
  that already saw the conversation resumes natively; one that joins later gets
  a digest of what happened.
- **Credit failover** — output is scanned for quota and auth signals. A CLI that
  runs out is marked, and the turn is replayed on the next one.
- **AGENTS.md sync** — the last turns are mirrored into a machine block in
  `AGENTS.md`, so a CLI you start by hand can pick the work up too.
- **Sessions travel** — resume or reference any saved session, including ones
  recorded in a different directory.
- **No lock-in** — zero dependencies, one JSON config, easy to add a CLI.

## Install

```sh
node bin/relay.js              # or: npm link   →  relay
```

Requires Node 18+. Nothing is installed into `~/.relay` until you run it.

## Quick start

```sh
relay                          # interactive shell
/connect                       # guided wizard: add any CLI to the rotation
/priority qwen claude junie    # who gets asked first
/priority move junie 1         # …or move one into position
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

## How a turn travels

| the CLI…            | relay gives it                                          |
| ------------------- | ------------------------------------------------------- |
| already saw this session | its own native session id (`-r`, `--session-id`)   |
| is new to this session   | a digest of the recent turns, in the prompt          |
| cannot resume at all     | the digest, every turn                               |
| speaks no JSON protocol  | project instructions inlined, plain text in and out  |

Quota and auth failures mark a CLI out of credits (cleared automatically after
3 hours, or now with `/forget`). Anything else is a soft 10-minute cooldown, and
the failing output is saved under `~/.relay/probes/` for tuning patterns.

## Commands

| inside relay           | does                                                     |
| ---------------------- | -------------------------------------------------------- |
| `<prompt>`             | send to the current CLI                                  |
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
