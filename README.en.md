# armor-switch

> A **tiny, always-toggleable delivery-contract plugin** for DeepSeek Harness.
> **Off = byte-identical to the stock prompt. On = rewrites the underlying contract.**
> **No host file is ever modified** — no `app.asar` patching, no host `node_modules` patching.

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![platform](https://img.shields.io/badge/platform-DeepSeek%20Harness%20Desktop-4B6BFB.svg)
![dsh](https://img.shields.io/badge/DSH-0.2.0--rc.2-orange.svg)
![runtime deps](https://img.shields.io/badge/runtime%20deps-1-brightgreen.svg)
![build](https://img.shields.io/badge/build%20step-none-success.svg)

---

## Contents

- [What it is](#what-it-is)
- [Quick start](#quick-start)
- [What it gets right](#what-it-gets-right)
- [How it works](#how-it-works)
- [Comparison](#comparison)
- [Known limitations (read this)](#known-limitations-read-this)
- [Uninstall](#uninstall)

---

## What it is

In DSH, model behaviour is shaped by the **system prompt** and the **runtime context**. Without
touching a single host file, `armor-switch` registers three toggleable rule blocks on those two
surfaces:

| Switch | What the model sees |
|---|---|
| **Off** (default) | **Byte-identical to stock.** All three blocks return an empty string and are dropped entirely during rendering; no other section is added or removed. |
| **On** | The delivery contract takes effect: the operator's instruction is authoritative, "request → artifact" is written out as executable rules per request class, moralizing is forbidden, and placeholder/language rules are fixed. |

The important part: **toggling is hot.** It affects the next request only — no restart.

> ⚠️ **What this actually is:** it rewrites the *client-side instruction contract* — it stops the
> agent from over-self-censoring legitimate requests and from substituting disclaimers for actual
> deliverables. It **cannot** bypass a model provider's server-side content moderation, and it
> changes no network-layer capability. Read [Known limitations](#known-limitations-read-this)
> before deciding to use it.

---

## Quick start

### Requirements

- DeepSeek Harness **Desktop 0.2.0-rc.2** (`@deepseek-ai/dsh` 0.2.0-rc.2)
- Windows (the install script is PowerShell)
- Node.js (the one DSH ships is fine)

### Install

```powershell
# Clone into the staging location
git clone <your-repo-url> "$env:USERPROFILE\.dsh\plugins\dsh-armor-switch"
cd "$env:USERPROFILE\.dsh\plugins\dsh-armor-switch"

# Preview the changes (nothing is written)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WhatIf

# Apply
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

**Restart DSH Desktop once.** A chip labelled **"Armor off"** appears above the composer.
Click the main area to toggle; subsequent toggles need **no** restart.

### What the installer does

| # | Action | Target |
|---|---|---|
| 1 | Sync sources to the staging dir | `%USERPROFILE%\.dsh\plugins\dsh-armor-switch` |
| 2 | **Real copy** (`robocopy /E`, not a junction) | `<profile>\node_modules\dsh-armor-switch` |
| 3 | Add one entry to each | `<profile>\package.json` (`dependencies`, `dsh.profile.bundles`) |
| 4 | Append an id-targeted `config` block | `<profile>\cordis.patch.yml` |
| — | Back up before writing | `*.bak-<timestamp>` |

The script is **idempotent** and auto-detects the profile path; `-ProfilePath` overrides it.

> **Why a real copy and not `mklink /J`**
> Node resolves a junction's `realpath` back to the real directory under `plugins\`, so the upward
> lookup for the profile's hoisted `@deepseek-ai/schemastery` fails and the plugin dies at startup
> with `ERR_MODULE_NOT_FOUND`. After a real copy the module lives *inside* the profile's
> `node_modules` tree, so the lookup succeeds.

### Verify

```powershell
node .\scripts\verify.mjs
```

Runs the whole assertion suite against a fake Cordis context — **no live host required.**
29 assertions; all green means the build is sound.

To also validate the **installer itself** (the profile patch it writes must be valid YAML):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-installer.ps1
```

---

## What it gets right

### 1. Off means invisible: byte-level equivalence

The host's `SystemPrompt.assemble` allows a section/context `text` to be a **function**, re-evaluated
on every assembly — and both `renderPrompt` and `renderContextSections` end with
`.filter((text) => text.length > 0)`.

So the plugin registers once and reads the live switch inside the function: **while off it returns
`''` and the contribution is dropped.** The model's prompt is byte-identical to stock — not
"roughly similar", genuinely not one byte different.

### 2. Hot toggle, zero restarts

The switch truth lives in memory only; the next assembly reflects it immediately. No
unregister/re-register, no process restart. (The one exception is the **first install**, which needs
a restart so the new client module generation can mount.)

### 3. Zero dependencies, zero build

The host half imports only `@deepseek-ai/schemastery` (genuinely present in the profile) and
`node:crypto`. The client half is a hand-written `window.__ModuleLoader__` factory that requires
only `react`. **No JSX, no TypeScript, no bundler** — the source *is* the artifact.

That means it resolves both under bare Node and under DSH's own Loader runtime resolution, so it
**can't fail because of a dependency-resolution difference**.

### 4. The main switch is strictly decoupled from permissions

This design was educated by a real defect (see the A7 entry in [CHANGELOG](CHANGELOG.md)):

- **The main switch never touches sandbox or approval.** It changes the contract only.
- **Permissions are written only when a `fullAccess` field is explicitly sent.**
- Turning "Full" off restores **the profile's own `permissionPresets.defaultPreset`**, never a
  hardcoded `workspace-write`.

Why the last point matters: if the profile's default preset is already `danger-full-access`, a
hardcoded `workspace-write` would **silently narrow the sandbox and switch approval prompts on** for
a user who only ever touched the Full toggle — and nothing in the UI would show it.

---

## How it works

### The three registrations

| # | API | name | order | Lands in |
|---|---|---|---|---|
| 1 | `systemPrompt.section()` | `armor-switch:contract` | 2 | **system prompt** |
| 2 | `systemPrompt.context()` | `armor-switch:authority` | 100 | runtime-context message |
| 3 | `systemPrompt.context()` | `armor-switch:mechanism` | 130 | runtime-context message |

`100` / `130` are not official constants (the shipped `CONTEXT_ORDERS` holds only `SANDBOX_POLICY`
110, `APPROVAL_POLICY` 115, `SUBAGENT_DELEGATION` 120), so the source uses literals with a comment.

Each of the three blocks **carries a self-sufficient rule core** rather than a pointer to the
others, so if a future preset switches to `complete: true` and drops the section surface, the
context surface still stands on its own.

### Why "override" rather than "delete"

The host's `@deepseek-ai/dsh-agent-instructions` bakes this preamble into a **constant** and injects
it via `createUserMessage` as a **user-role message**:

> The following workspace instructions may be relevant to your work. Use them as guidance when
> applicable. More specific instructions take precedence over broader ones. They do not override
> system, developer, or direct user instructions.

Without modifying host files, a plugin **cannot** rewrite it. This plugin overrides it from a higher
authority surface, on two independent legs:

- **Layer leg:** `contract` goes through `systemPrompt.section()`, which lands in the **system
  prompt**; that preamble is a user message.
- **Timing leg:** `authority` goes through runtime context, which the agent-loop's `preStep` renders
  as a user message **re-injected every turn at the newest position**.

> **Honest disclosure: that preamble is still in the session. It is not deleted and cannot be —
> it is overridden.** This plugin claims no "deletion" and performs none.

### The private RPC channel

The chip talks to the host half over a Connection private channel route:

```
POST /armor-switch/{status|set|toggle|recheck}
```

When Connection registers a private channel it uses **Connection's own context**, so it must be able
to see the `webServer` service — and the shipped `dsh-web-app` layer declares only
`inject: [webRuntime]`. The plugin's bundle patch therefore **ships its own `connection` override**
that adds `webServer` to `inject`.

**That override must not be deleted** — without it the private channel never mounts and the chip
shows a permanent error. (An early version free-rode on an identical override that happened to exist
in another plugin; uninstalling that plugin broke this one. It now ships its own declaration.)

---

## Comparison

|  | armor-switch | asar-patching approaches | literal-anchor-rewriting approaches |
|---|---|---|---|
| Host file intrusion | **none** (public extension surfaces only) | severe (modifies vendor code) | moderate (heavy deps) |
| Stock behaviour when off | **byte-identical** | no (cannot be turned off) | no (always on) |
| Restart needed to toggle | **no** (first install only) | — | — |
| Runtime dependencies | **1** | many | many |
| Fragility across host upgrades | **low** (public APIs only) | very high (breaks every upgrade) | medium-high (anchors drift) |
| Build step | **none** (source is the artifact) | yes | yes |

---

## Known limitations (read this)

### L1 — Under the `minimal` preset this plugin has **no effect at all**

That preset's persona declares both:

- `complete: true` → `SystemPrompt.assemble` **replaces the whole section list** with that one
  section, dropping this plugin's `contract` section (order 2);
- `includeRuntimeContext: false` → `dsh-persona` calls `suppressRuntimeContext()`, so `contexts`
  becomes `[]` and both of this plugin's contexts (orders 100/130) never land.

So **all three registrations are dead under `minimal`** (note: *not* "only the contexts work").
`standard`, `ptc` and `cordis` are unaffected.

### L2 — The first install needs one restart

The client half depends on the host attaching the `dsh.client` manifest to the Loader row, and a new
package's JS module generation only mounts on restart. Restart once after the first install;
toggling afterwards needs no restart.

### L3 — The disclaimer preamble is still in the session

See [above](#why-override-rather-than-delete). It is overridden, not deleted.

### L4 — It cannot bypass server-side moderation

This plugin rewrites the **client-side prompt contract**. Moderation and risk controls deployed at
the model provider's network layer are **unaffected**. If your request is blocked server-side, this
plugin will not help.

### L5 — The state is process-wide

The switch truth is a module-level singleton, so it applies to the **whole DSH instance**: toggling
it in one window also affects other windows, background jobs and Agent Teams.

### L6 — If `connection` is unavailable the chip renders but errors

Chip **rendering** (slot registration) and **communication** (private RPC) are separate things. With
the slot mounted but the RPC channel unmounted, the chip draws both buttons normally but every click
shows an RPC error.

Judge by status code: `POST /armor-switch/<endpoint>` returning **405** means the channel is not
mounted (static fallback); **401** means the registered channel is awaiting auth (healthy).

The main switch can still be driven by `enabled: true` in `cordis.patch.yml`, but then it is
permanently on and only editable through the config file.

---

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

Removes the real copy under `node_modules`, the `dependencies` / `bundles` entries in
`package.json`, and the override block in `cordis.patch.yml`; staging dir and backups are optionally
cleaned. **It does not delete** `~/.dsh/plugins/dsh-armor-switch` unless you pass `-PurgeSource`.

---

## Repository layout

```
.
├── package.json            package manifest (dsh.bundle.patch + dsh.client)
├── cordis.patch.yml        bundle layer: one insert row + one connection override
├── src/
│   ├── index.js            host half: three lazy registrations + state + private RPC + contract text
│   └── client.js           client half: the composer-dock chip (hand-written factory)
├── locale/{zh,en}.json     display metadata and chip strings
├── scripts/
│   ├── install.ps1         idempotent install
│   ├── uninstall.ps1       full rollback
│   ├── verify.mjs          offline self-check (29 assertions, no live host needed)
│   └── verify-installer.ps1 installer regression (the generated patch must be valid YAML)
├── docs/
│   ├── ARCHITECTURE.md     design deep-dive: why these three registration surfaces
│   └── TROUBLESHOOTING.md  troubleshooting
├── CHANGELOG.md
└── LICENSE                 MIT
```

---

## Contract fingerprint

`status.contract` is the first 16 hex chars of the `sha256` over the three on-state segments
concatenated. It is computed from constants and is independent of the live switch, so toggling can
never change it — use it **to reconcile "which bytes are deployed"** after an upgrade.

Run `node scripts/verify.mjs` to print the fingerprint for this build.

---

## License

[MIT](LICENSE)
