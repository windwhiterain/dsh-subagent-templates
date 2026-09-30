# dsh-subagent-templates

Named subagent templates for DeepSeek Harness. Each template fixes a starting
route — one provider/model pair, or a route pool a route is resolved from per
child — an agent preset, and an optional persona, so a delegating agent picks a
template by name and description instead of naming a provider, a model, and a
reasoning effort on every call.

This is an out-of-tree bundle. It imports no Harness package: it is plain
JavaScript over the `ctx` services, and `lib/harness.js` holds the small amount
of Harness behavior it replicates. Nothing in the Harness checkout changes.

## A template call creates an ordinary Session

A delegation is not a Harness subagent. It creates a **root Session**, exactly
the way a person opening a session by hand does:

```
workspaceRegistry.create(cwd)   → a workspace in the parent's directory
agents.create({ sessionId })    → a top-level Agent on the template's route
workspace.attachSession(id)     → it appears in the normal session list
agent.followup(prompt)          → it starts working
```

This is the shipped webhook Session-creation path
(`packages/webhook/webhook/src/session.ts`), not an invention. The consequence
is the point of the design:

- **The model picker stays available.** The Client hides model selection for a
  session it considers a subagent — `@deepseek-ai/dsh-client-ui-model-selection`
  refuses any session with a `subagentAddress`, because those RPCs would
  activate persisted history outside the direct-parent continuation path. A
  delegated task and a session the user opens are the same kind of thing, so
  they get the same surface: the picker, the preset selector, permission
  presets, and a composer the user can type into.
- **The user's choice wins over the template.** The template's route is the
  child's *initial* selection, applied only until the child has its first
  durable request header. Once the user changes the model in the picker, that
  change is what the child runs on.
- **A child can delegate again.** Because the child is a normal session running
  the same preset composition, it holds the same `subagent` tool and can open
  its own template sessions. Nesting needs no recursion budget, because none of
  this travels through `ctx.subagents`.

Because the child's header deliberately carries **no** `parentSession` and no
`origin`, the Client never classifies it as a subagent. The parent/child
relationship therefore cannot live in the header — those two fields are exactly
what would re-hide the picker — so it lives in this plugin's own storage domain
(`subagent_templates`, table `children`) instead.

## The parent names every child

Every delegation carries a `name`, and that name is the child's **only handle**:

| Where the name appears | What it does |
| --- | --- |
| the child's Session title | the sidebar tab, the session list, and the panel row all read the same word |
| the `subagent` tool result | a background call returns `{ kind, name }`; no Session id ever reaches the model |
| the settlement notice | `subagent "explorer" finished.` — the parent refers to the child by this word |
| `delete_subagent` | takes `name`, not a Session id |
| the child's own prompt | tells the child what it is called, so `ask_parent` can speak for itself |

The name is stored **verbatim**: no character set is imposed, no case folding, no
normalization. It must be non-blank, because it becomes a title and a handle. It
is **unique among one parent's live children** — two children of the same parent
cannot share a word, or every later reference to either would be ambiguous. A
duplicate is refused *before* anything is created, so the failed call costs
nothing; an in-flight claim covers two calls in one turn, which run
concurrently. Deleting a child frees its name again.

Two different parents may each have a child called `reviewer`. The uniqueness is
per parent, because that is the scope any reference is resolved in.

## One delegation world, not two

A template child is an ordinary root Session. That is what keeps its model
picker and its full Session surface, and it is also exactly why it is
**deliberately absent from `ctx.subagents`**. The native delegation tools all read
that registry, so none of them can serve a template child:

| Native tool | Why it cannot serve a template child |
| --- | --- |
| `list_agents` | reads `ctx.subagents`, which holds no template child — it would report an empty list |
| `send_message` | reaches only a **resident continuable** child, and the Harness refuses that route for a session it does not classify as a subagent |
| `interrupt_agent` | authorizes against a target's recorded lineage in the subagent service |
| `subagent_fork` | creates a native child: a second kind of object with a second lifecycle |

This is not a configuration oversight. Registering a child with `ctx.subagents` is
*precisely* the thing that makes the Client treat it as a subagent and hide its
model picker, so the two are mutually exclusive for the same child.

This plugin therefore supplies the three capabilities that mattered, over its own
mapping and naming:

| This plugin | Replaces | What it does |
| --- | --- | --- |
| `list_subagents` | `list_agents` | this session's children, by name, with the template each runs under and whether it is `working`, `idle`, or `ended` |
| `message_subagent` | `send_message` | sends to a child by name: a working one takes it at its next step, an idle one starts a new turn with it |
| `interrupt_subagent` | `interrupt_agent` | stops a child's current work and **keeps** it — session, transcript, and name all survive, so a message afterwards redirects it |

`interrupt_subagent` and `delete_subagent` are the two ends of one decision:
interrupt stops the work and leaves the child usable, delete ends it. An
interrupted child reports nothing for the turn that was stopped, because it did
not finish and there is no result to report; the delegation itself is still open,
and whatever the child's next turn produces is what reports (see "Results").

Two things are deliberately **not** reproduced:

- **`subagent_fork`.** An inherited-context child is a different kind of object
  with a different lifecycle, and re-adding it would reopen exactly the split this
  design removes. Delegation with a self-contained prompt is what templates are
  for.
- **A subagent tree.** `list_subagents` reports direct children only, because that
  is the scope the other tools can act on: a child that delegates again has its own
  children, reachable from that child. A grandchild is a real object with no name
  this session could use.

To use the native tools instead, re-enable `tool-subagent-control`,
`tool-subagent-control/list-agents`, and `tool-subagent-fork`. A session then has
both surfaces, which is the state this plugin exists to avoid.

One caveat about the preset registry: a deployment decides which presets it
exposes and which one is its default. Disabling the three rows in that default
preset covers new sessions, but a session that explicitly selects a preset which
still mounts them gets the native surface back. Overriding such a preset would
mean restating its whole `config`, which is a worse trade than a preset choice
the user can see.

## A child can ask its parent

A delegated task usually has something the parent knows and the child does not:
a decision it already made, a file it meant, an answer it holds. A template
child is an ordinary Session, so it inherits the deployment's `send_message` —
which reaches only a *resident continuable child*, and the Harness refuses that
route for a session it does not classify as a subagent. This is that missing
route.

In the child's creation window the plugin registers, **on the child's own
scope** so no other Session ever sees it:

- **`ask_parent`** — send the delegating session a question or a finding. The
  message is delivered exactly as a subagent's message is: the parent receives
  it at its next step (an idle parent is woken). It carries the same
  `agent-message` attribution, so the transcript shows who asked — the header
  opens `subagent "<name>" sent a message:`, naming the child rather than its
  Session id, and the attribution's own `senderSessionId` keeps the sending
  Session identifiable. There is no
  reply inside the child's turn, so the tool's own description asks for a
  question the parent can answer in one go.
- **a runtime context** naming the parent Session and explaining the channel:
  that the child is a delegated task, that it cannot see the parent's
  conversation (nor the parent its own), and that its final message already
  reaches the parent automatically — so `ask_parent` is for what the final
  message cannot carry, not a second copy of it.

The child also keeps the deployment's `send_message`, and the context says
plainly that this route cannot reach the delegating Session. It is deliberately
**not** withdrawn: a template child holds `subagent_fork` (in the `personal`
preset), which creates a *continuable* child, and `send_message` is the working
route to that one. Denying it on every child would remove a capability that
works.

## What it mounts

| Registration | Scope | Purpose |
| --- | --- | --- |
| `subagent` (name is `toolName`) | the Host plane | delegates to one template under a `name` the parent chose, stating `run_in_background`; returns the child's output in the foreground, or that name in the background |
| `list_subagent_templates` | the Host plane | reports each template's model and agent preset |
| `list_subagents` | a delegating session's own scope | this session's children, by name, with template and work state |
| `message_subagent` | a delegating session's own scope | sends a message to one of the caller's own children |
| `interrupt_subagent` | a delegating session's own scope | stops one child's current work and keeps the child |
| `delete_subagent` | a delegating session's own scope | the delegating agent deletes one of its own children, by name |
| `ask_parent` + a parent-identity context | each child session's own scope | lets a delegated child ask its parent a question |
| the `subagentTemplates` Session projection | the host | publishes a parent's children to the Client panel |
| the `Subagents` right-Sidebar tab | the browser | lists this session's children, and opens or deletes one |

## A session carries only the tools it can use

Only `subagent` and `list_subagent_templates` are registered at the Host plane.
The four tools that act on children — `list_subagents`, `message_subagent`,
`interrupt_subagent`, `delete_subagent` — are installed into **a session's own
agent scope, at the moment that session's first delegation succeeds**.

Before its first delegation every one of them could only answer "you have no
subagent named that", so a session that never delegates never carries them: four
tools of prompt for nothing, and four tempting dead ends. An agent-scoped
registration also means the tools belong to one session rather than to the
deployment — a child that delegates gets its own set for its own children, and no
unrelated session ever sees them.

Two consequences worth stating plainly:

- **They appear in the session's *next* model request.** The delegation already
  happened; a tool cannot appear in a request that is already in flight.
- **They are never withdrawn again.** A session that has delegated may delegate
  again at any point, and after its last child is gone they answer honestly
  (`(no subagents)`, `unknown`) rather than the session having to earn them a
  second time. That is also the only way `list_subagents` can report nothing.

A hot reload replaces this plugin and loses every scope it adopted while the
children it recorded are still in the store, so activation adopts the live
sessions that already have children — found through the Agent registry and the
mapping store. Without that, a reloaded session would keep working and silently
have no way to manage what it delegated.

## The panel

The browser half (`client.js`) adds one tab type to the right Sidebar through the
two public stages any external tab type uses: `sidebarRightTabs.register` for
what the type *is*, and a keyed `sidebar.right.pane.tab` registration under that
definition's own `id` for the body. A guide entry is what makes the tab
discoverable.

The body is mounted per session and reads only framework data: the Host's
`subagentTemplates` projection for the template facts, the Session catalog for
whether a child still exists, and the per-session running state for the status
dot. It holds no subscription of its own and never touches the storage domain.

Each row is the child's name — the same word the parent uses — its template, its
age, and its state. Clicking the name opens the child through the shipped
workspace navigation, so it arrives as an ordinary session with its own picker.
Deleting asks inside the row and then performs the shipped archive-with-stop; the
plugin invents no session lifecycle. A child leaves the list when the Session
catalog drops it, which is the archive's own consequence, so a refused archive
keeps the row and puts the reason on it.

## A child is never reaped automatically

A delegated child is an ordinary Session, so it lives until something
**explicitly** ends it:

- the **user** deletes it from the panel or from the session list, or
- the **parent agent** calls `delete_subagent` with the child's name.

Nothing else does. In particular a delegated child is not stopped when its
parent session closes, and not stopped when this plugin unloads — a code reload
must never destroy work in progress. `delete_subagent` stops the child, releases
its handle, and archives its session (removed from the lists, log kept), which is
the same operation the panel performs. It is scoped to the caller's own children:
a name the caller never gave is refused, with a result that says so rather than
one that names somebody else's child. To stop a child's work **without** ending
it, use `interrupt_subagent`.

That lifetime needs **two** owners, and neither is the delegating call.

- **The creation signal** is the first. An Agent's whole life is fused to the signal its
  creation passed (`agent-loop` keeps a listener on it from `createAgent` until disposal),
  so a child created with the tool call's own `exec.signal` is torn down the moment that
  call returns — which is exactly what a background delegation does. The child is created
  with a controller this plugin owns instead.
- **The context the Agent is created through** is the second, and it is the one that is
  easy to lose. `ctx.get()` returns a traced service, and `AgentRegistry.create()` binds
  the new Agent's lifecycle to the context the call was read through: `agent-loop`
  registers the Agent's whole teardown as an effect of that context's fiber, cancelling
  its machine with `disposed` when the fiber unloads. Created through this plugin's own
  context, a child would die with this plugin's loader entry — on an HMR edit of a watched
  file, or on any profile recomposition whose composed row for this entry changed, which
  is what every Plugin Manager action causes. Every child is created through the
  **application root context** (`ctx.root`) instead, whose fiber unloads only when the
  process exits. That is what makes "not stopped when this plugin unloads" true rather
  than aspirational.

**Reading a child's last log line.** A child that ran to completion ends
`turn/end reason={"kind":"completed"}`. A child that was *deliberately deleted*
(`delete_subagent`, or the user) ends
`turn/end reason={"kind":"aborted","reason":{"kind":"disposed"}}` — the same
record shape a **bug** produces when a child dies with no delete call. The
discriminator is not the shape; it is whether anything asked for the deletion. A
child that dies `disposed` on its own is the lifetime-binding bug above.

## Configuration

```yaml
- id: subagent-templates
  name: 'dsh-subagent-templates'
  config:
    toolName: subagent        # optional; the model-facing tool name
    maxDepth: 1               # optional; how deep delegation may nest (default 1)
    maxActiveSubagents: 4     # optional; how many children may work at once (default 4)
    templates:                # required; at least one
      - id: medium            # required; lowercase letters, digits, hyphens; the `template` argument
        name: Medium          # required; display name
        description: >-       # required; when to pick this template, in the model's vocabulary
          Executes and explores: reads code, runs commands, and reports what it found.
        provider: command-code-goat   # one route: a registered LLM provider id …
        model: deepseek/deepseek-v4.1-flash  # … and a model that provider serves
        # pool: medium        # … OR the name of a route pool owned by dsh-llm-quota-retry
        preset: personal      # optional; agent preset the child joins (default: the deployment default)
        reasoningEffort: high # optional; the child's starting thinking effort
        maxTokens: 64000      # optional
        persona: You are…     # optional; the child's own persona
        toolFilter:           # optional; the child's narrowed tool set
          deny: [write]
```

A template fixes only what a child *is*. It does not say whether a delegation
waits; `run_in_background` on the call does.

### One route, or a pool to resolve one from

A template fixes **exactly one** of:

- `provider` + `model` — one fixed route. Both are required, and neither may be
  empty.
- `pool` — the name of a route pool owned by
  [`dsh-llm-quota-retry`](https://github.com/windwhiterain/dsh-llm-quota-retry).
  The route is resolved **per child**, right before that child exists, from the
  pool's ordered routes, skipping the ones whose provider is out of allowance. So
  two subagents of one template can start on different providers, and a template
  is how a session says "any of these will do, pick one that works".

Declaring both, or neither, fails the row at activation. A `pool` template whose
service is not mounted, or whose pool that service does not define, fails the
delegation with a message naming the template and the pool — a child on the
deployment's default model would be a delegation nobody chose.

`reasoningEffort` on the template is the fallback: a resolved route may bring its
own effort, and that one wins for the child. `maxTokens`, `preset`, `persona`,
and `toolFilter` are untouched by the pool.

`list_subagent_templates` reports which form each template uses, so the model can
tell a fixed route from a pool without a second delegation.

### The effective template list comes from the profile patch

This package's own `cordis.patch.yml` is a **bundle layer**: the host re-reads it
on every profile recomposition but never watches it, so an edit there applies at
the next recomposition rather than when it is saved. A profile override replaces
the whole `config` object, so the effective list is the last layer that declares
one.

The only layers the host watches are the profile's own `cordis.patch.yml` and
`$DSH_HOME/cordis.patch.yml`. Put your templates in the profile's:

```yaml
- id: subagent-templates
  name: 'dsh-subagent-templates'
  disabled: false
  config:
    toolName: subagent
    templates:
      - id: medium
        name: Medium
        description: >-
          coding, implement, explore, investigate.
        provider: opencode-go
        model: deepseek-v4.1-flash
        preset: personal
        reasoningEffort: high
```

An id-targeted override must restate every key the row needs — `toolName` and
`templates` here, with `maxDepth` and `maxActiveSubagents` falling back to their
defaults. Saving that file applies the new list without restarting the host, by
restarting this row: `apply()` re-runs and the tools re-register, while live
children are untouched (they are root Sessions created through the application
root), and a settlement watch or a waiting foreground call keeps working across
the restart — both read the Agent registry through that same root context.

A template's `provider`, `model`, and `reasoningEffort` are the child's starting
route: they seed its first request, and the child's own model picker can change
them afterwards. A `pool` template's route is chosen the same way, from the pool,
and the child's picker can change that too — and once the route it moved to falls
outside the pool, `dsh-llm-quota-retry` stops managing it.

`persona` gives the child a persona of its own. It is registered as a
`deployment:persona-prefix` section on the child's scope, so it shadows the
deployment persona for that one child and is invisible to the parent and to its
siblings. A template without one leaves the deployment persona alone.

`toolFilter` narrows what the child may call, as `allow`, `deny`, or both. It is
applied as a `restrict()` on the child's scope, so it intersects with whatever the
child's preset already admits and never widens it.

### `maxDepth`

`maxDepth` bounds how deep delegation may nest, and **defaults to 1**: a session
may delegate, and a child of that delegation may not delegate again. A delegation
is refused when it would create a child deeper than the cap, counting a session
that has delegated nothing as depth 0, so its child is depth 1. Set it higher, or
to `provider-managed` to state that the bound belongs to the delegation provider
— this plugin delegates to ordinary root Sessions and mounts no provider, so it
enforces nothing for that value.

A template child carries no `parentSession` header — that omission is what keeps
its model picker — so the Harness cannot answer its depth. The plugin counts it by
walking its own mapping store instead. With no storage domain form mounted there
is no recorded chain to walk, so the cap cannot be enforced and delegations
proceed.

### `maxActiveSubagents`

`maxActiveSubagents` bounds how many of one session's children may be **working at
once**, and **defaults to 4**. A child that has finished stops counting, so it
frees its slot immediately — the same rule the Harness's own subagent activation
pool follows. A child that finished but was never deleted therefore does not block
new work; only children still running do.

The cap is per delegating session, not per host: each session gets its own, exactly
as each session has its own child names. It reads the same mapping store as
`maxDepth`, so with no storage domain form mounted the count is unanswerable and
delegations proceed.

Configuration is validated at activation: an unknown field, a malformed id, a
duplicate id, an unusable `toolFilter`, a `maxDepth` that is neither a
non-negative integer nor `provider-managed`, or a `maxActiveSubagents` that is not
a positive integer fails the row instead of the first delegation. A `background`
field from an older patch is an unknown field, so it fails the row rather than
being ignored.

## Results

A **foreground** call waits for the child's turn to settle and returns its
closing text as the tool result — that call's result and nothing else, because
the parent is reading it there.

A **background** call returns the child's name immediately and delivers the
child's output to the parent as a `subagent-settled` notice when the child
finishes on its own terms. An idle parent is woken; a busy one receives it at its
next step. No collection call is involved.

An **interrupted turn is not an outcome.** A user who stops a delegated child is
redirecting it rather than ending the delegation: the child keeps its session and
everything it had done, so a foreground call keeps waiting for it and a
background watch stays armed. Whichever turn the child ends naturally is what
reports — the foreground call's tool result, or a `subagent-settled` notice — and
the interruption itself never fails a delegating call and never answers one. A
child nothing wakes again leaves the wait pending on purpose; `delete_subagent`,
or cancelling the delegating call, is what ends it.

Only a **natural end** is reported: `completed`, `max-tokens`, or the child's own
failure. A turn the host refused admission to (`blocked`) and a turn that never
ended are stops rather than results, so a background watch reports nothing for
either; a deleted child reports nothing at all.

## Install

From the directory that contains your checkout of this repository:

```sh
dsh plugin --profile <profile> add ./dsh-subagent-templates
```

or the Plugin Manager's install action with this directory as the target. The
bundle patch inserts the row at the Host plane.

A profile that mounts `dsh-base` without `dsh-web-app` (the shipped `headless`
profile) also has the base bundle's own host-plane `tool-subagent` row, which
registers the same `subagent` name; one tool layer rejects two registrations of
one name, so disable that row first:

```yaml
- id: tool-subagent
  disabled: true
```

The web profile ships it disabled already.

## Use it in a preset

The shipped presets mount `@deepseek-ai/dsh-tool-subagent` themselves, and a
nearer scope wins a tool name. To make a preset delegate through templates
instead:

1. Drop the preset's `tool-subagent` row (in the profile's own
   `cordis.patch.yml`) so the Host-plane template tool owns the `subagent` name.
2. Disable `tool-subagent-control`, `tool-subagent-control/list-agents`, and
   `tool-subagent-fork` in the same preset. They read `ctx.subagents`, which holds
   no template child, so they would report nothing and refuse every id.

Leave `tool-subagent-codex` and `tool-subagent-claude-code` alone; they are
disabled by default and delegate to external CLIs, which is a separate capability
rather than a second route to the same children.

## Known Limitations and Deferred Work

- **No parent/child grouping in the shipped sidebar.** The child is a normal
  session, so the official workspace tree lists it as its own session rather than
  nested under the parent. This plugin's own panel is where the grouping shows;
  the tree is not extended.
- **Deleting from the panel leaves the mapping record behind.** The panel performs
  the shipped archive-with-stop, so the child Session goes and the panel row goes
  with it, but this plugin's own mapping row survives until the parent agent calls
  `delete_subagent` for that name. A later call re-archives an already-archived
  Session, which is a no-op. A Host-side delete reachable from the panel would
  remove both in one step; it is a client-to-Host call this plugin does not make.
- **A background child is stopped by interrupting or deleting it, not by
  `interrupt_agent`.** That tool authorizes against a target's recorded lineage
  in the subagent service, which a root-session child has none of. Use
  `interrupt_subagent`, or — since the child is a normal session — its own stop
  button.
- **The plugin owns the child Agent's lifetime.** A root Session created here is
  not registered with `ctx.subagents`, so `send_message`, `list_agents`, and the
  team panel do not see it. Open the child's own tab to talk to it.
- **A child that outlived this plugin keeps running with no handle in memory.** A
  reloaded instance rebuilds the mapping and the parent's tools, but the
  `AgentHandle` that created the child died with the previous instance, so
  `delete_subagent` stops such a child through the shipped archive-with-stop path
  (the Agent registry answers `workspace/session-stop` by cancelling its turn)
  rather than by disposing a handle it no longer holds. The Agent object itself
  stays registered, idle and archived, until the process exits — the residue the
  shipped panel already leaves for any archived Session.
- **No per-call model override.** A call names a template and nothing else, by
  design; a pool template's route is resolved by the pool, and changing the
  child's model afterwards is the user's action in its picker.
- **A pool template depends on `dsh-llm-quota-retry`.** The pool, its balance
  scripts, and the allowance marks belong to that plugin: this one only asks it
  which route a child should start on, and fails the delegation loudly when the
  service is absent or the pool is undefined. A template with a fixed
  `provider`/`model` needs nothing from it.
- **No structured output.** A template call returns the child's closing text.
- **No editing UI.** Templates live in configuration. Put them in the profile's
  own `cordis.patch.yml`, which is watched, and an edit applies to the next
  delegation without a host restart — see "The effective template list comes from
  the profile patch".
- **Replicated Harness internals.** `lib/harness.js` mirrors shipped files that a
  bundle cannot import. A Harness upgrade that changes the final-output
  selection rule or the turn-end vocabulary must be reflected there. The file
  names its sources.
- **The client half has no bundler.** `client.js` is served as one classic script,
  so it imports nothing, reaches React and the shared primitives through the
  module system's `require`, and injects its own stylesheet from `--dsw-*` tokens
  instead of shipping a CSS file. A panel that grew real styling would want the
  same treatment the shipped packages get.

## Durable storage

The mapping lives in the `subagent_templates` storage domain, one record per
delegated child, keyed by the child's Session id. The record names its parent, the
name the parent gave it, the template it ran under, the time, and the working
directory.

The record's identity field changed from `label` to `name` when the naming
requirement arrived, and the **unit version did not move**. That is deliberate: a
record written before the requirement held a task description in `label`, which
was then the only word that record had for its child, so the validator reads it
as the name and the record is rewritten in the new form on the next write. A new
reader that accepts both records and always writes the current one is a
backward-compatible change, not a migration — so there is no version to declare
compatible, no record to back up, and no unit to move to another layout. The
unit's version can be raised later, once no old record remains.

`probe/store.probe.mjs` opens the profile's real `subagent_templates.json` with
this plugin's own spec, through the Harness's own JSON storage backend, and
fails if any record in it would be refused. That is the check a format change
actually needs, because a record the Host cannot read is a row that fails to
activate.

## Developing against a live host

This plugin runs as a `link:`ed bundle, so the host executes whatever is on disk.
Source hot reload is **opt-in per file** through the `hmr` row's `root` list in
the profile patch, and that list must be kept in step with the plugin's actual
files: a root naming a deleted file is dead weight, and **a module missing from
the list silently never reloads**.

That failure is quiet and expensive. An edit to an unwatched module leaves the
host running the old code while every other module reloads, so the host runs a
mixed build: a fix appears not to work, disappears intermittently, and looks
like a race or a lifecycle bug rather than a missing watch entry. When a change
seems not to take effect, compare each source file's mtime against the last
`cordis.patch.yml` write before suspecting the code, and add any module the
list does not name.

A reload restarts this plugin's loader entry, and it is not the only thing that
does: this bundle's own `cordis.patch.yml` is re-read on every profile
recomposition rather than watched, so an edit to it applies at the next one — and
a recomposition that changes this entry's composed `config` restarts the entry.
Live children survive all of that, because they are created through the
application root context rather than this plugin's (see "A child is never reaped
automatically"); a child that dies `disposed` anyway means that rule has been
broken again. So does everything that has to outlive the entry: the settlement
delivery and the child's `ask_parent` read the Agent registry through that same
root context, and an armed settlement watch lives on the child's own scope, so a
template edit mid-delegation neither loses a child's result nor strands it.

The host also has no way to load a plugin's client half unless its `package.json`
declares the `./client` export and the `dsh.client` manifest; a client file that
is present but undeclared is simply never loaded, and a declared one that throws
takes the whole browser plugin batch down with it.

```sh
node probe/probe.mjs
node probe/client.probe.mjs
cd /path/to/deepseek-harness
DSH_HARNESS_ROOT=$PWD node --import tsx/esm /path/to/dsh-subagent-templates/probe/store.probe.mjs
```

`probe/probe.mjs` and `probe/client.probe.mjs` need no Harness. `probe/store.probe.mjs`
drives the Harness's own storage code, so it runs from a Harness checkout with
`DSH_HARNESS_ROOT` set to it.

`probe/probe.mjs` runs the delegation path — session creation, the name that
titles it, name uniqueness, the required background flag, preset join, the model
default the user can override, a pool template resolving a different route for
each child and failing loudly without its service, foreground settlement,
background delivery, a
stopped turn reporting nothing and being waited through, the two owners that keep
a child alive (the creation signal, and the app root context it is created
through), the three tools that
stand in for the native ones, the scope they are installed into, adoption after a
reload, `delete_subagent` by name, the projection rows, the mapping store, and
configuration rejection — against in-memory fakes, with no Harness and no model.
Its delegation helper takes the background flag as a separate argument and refuses
to run without it, so no probe call can quietly stop testing the call a model
actually makes, and it reads the child-management tools out of the parent agent's
own scope rather than the Host plane, which is the boundary under test.

`probe/client.probe.mjs` runs the browser half the way the module system runs it:
the file is loaded with a `window.__ModuleLoader__` and a `require`, and the tab
body it registers is driven against a jsdom document and the real React taken from
the Harness checkout's pnpm store. It checks the two-stage tab registration, that
both dictionaries carry the same keys, the row the panel draws, opening a child,
the delete question, the archive it performs, a refused archive, and the two ways
a child stops being listed. It does not prove the panel inside a real browser.

`probe/store.probe.mjs` runs the mapping store against the Harness's own storage
code over a copy of the real store, which is where a record-format change is
decided. It is the one probe that needs the Harness checkout, for its TypeScript
sources and `tsx`.

[probe/isolated-e2e.md](probe/isolated-e2e.md) is the keyless end-to-end run
that proves the same delegation path through a real Loader tree and app in an
isolated profile, and records the assertions to read out of the session logs.

## License

MIT
