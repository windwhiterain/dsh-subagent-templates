# Isolated keyless end-to-end run

How to prove this plugin's delegation path end to end without an API key and
without touching a live host. The recipe was executed and the assertions below
were observed in real session logs; keep it current when the composition
changes.

## Isolation rules

- Use a separate `DSH_HOME` (this repository's `.dev-artifacts/home` is
  git-ignored). Never point it at the working `~/.dsh`.
- Never boot a web profile and never pass `--port`: a live web host owns the
  default port.
- Create the profile with a `--dump-config` mode, which initializes it without
  booting.

## Steps

From the DSH checkout:

```sh
$env:DSH_HOME = '<repo>/.dev-artifacts/home'
pnpm dsh --profile t --from-default-profile headless --dump-config
pnpm dsh plugin --profile t add <repo>
```

Then write `<repo>/.dev-artifacts/mock-llm.js` and the profile patch at
`<DSH_HOME>/profiles/t/cordis.patch.yml`.

### The mock model

`ctx.llm.registerAdapter(['<route>'], adapter)` accepts a plain object, but the
runtime calls the adapter's methods directly, so the object must supply every
one the `LlmAdapter` base class would have provided instead of inheriting them:

`providerInfo`, `providerRetryPolicy`, `imageRequestPricing`, `listModels`,
`resolveModel`, `prepareCall`, `stream`. A missing one fails the first call with
`TypeError: adapter.<method> is not a function`.

`stream(options)` is an async generator of the chunk vocabulary
(`block-start` / `text-delta` / `tool-call-delta` / `block-end` / `usage` /
`finish`). Script it on the request content. Do NOT detect a child by a word such
as `subagent`: the parent's system prompt is this checkout's `AGENTS.md`, which
contains that word. Detect by a tool-call id the mock itself emits, or by the
delegation context text, which opens `You are working on a task another session
delegated to you` and names the child in `You are the subagent "<name>"`.

Register a second route for the parent so the child's route is contrastive.

### The profile patch

```yaml
- id: llm-deepseek
  disabled: true

# The shipped headless runner routes its task agent from ctx.agentDefaultModel;
# `agent-loop`'s own `agents` rows only create idle agents.
- id: agent-default-model
  config: { provider: templates-mock-parent, model: templates-mock-parent }

# dsh-base also registers `subagent` in the host-plane tool layer, and one layer
# rejects two registrations of one name.
- id: tool-subagent
  disabled: true

# The template row this repository ships names real providers and the `personal`
# preset; override the whole `config`.
- id: subagent-templates
  config:
    templates:
      - id: medium
        name: Medium
        description: Executes and explores.
        provider: templates-mock
        model: templates-mock
        preset: personal

- insert:
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config: { default: personal, selectedDefault: personal }

    # A tool only this preset mounts proves the child joined it: the parent's
    # request then lacks that tool name and the child's carries it.
    - id: preset-personal
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: personal
        name: Personal
        plugins:
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config: { allowParallelInProgress: true }

    - id: templates-mock-llm
      name: '<repo>/.dev-artifacts/mock-llm.js'
```

`tool-todo` requires `allowParallelInProgress`; without it the row fails to mount
and every delegation returns its config error. Disable the root `tool-todo` so
the tool is genuinely preset-only.

A profile that mounts `dsh-base` alone has no `workspaceRegistry` or
`sessionTitle`; insert `@deepseek-ai/dsh-workspace` and the Session-title service
or every delegation fails with "creating a template session needs the agents,
workspaceRegistry, and sessionTitle services". Both are checked before anything
is created, so a deployment missing either fails the call instead of leaving an
unnamed child behind. The `web` profile gets them from the web-app bundle.

The storage domain facility is reached through the **global storage hub**
(`ctx.storage.form('domain')`), not `ctx.get('storageDomain')`: the facility is
subtree-scoped and invisible to a third-party plugin, and a fake that answers the
subtree key will make an empty mapping look fine.

## Run and assert

```sh
pnpm dsh --profile t "delegate the greeting through the medium template"
```

Read the JSONL written under `<DSH_HOME>/sessions/**` (zstd frames; decompress
per frame). **Do not read the pass signal from stdout.** A scripted mock that
ignores tool errors ends a run with a success-shaped `PARENT_FINAL` reply even
when the `subagent` tool threw, so a green run and a failed delegation look
identical on stdout. The authoritative signal is the parent's `tool/result` for
the `subagent` call carrying the child's text, plus the absence of the
`openMappingStore: …` style stderr diagnostic. Assert:

1. The child session header carries `agentPreset` equal to the template's preset
   and **no `parentSession` and no `origin`** — it is a root session, not a
   subagent child, which is what keeps the model picker available. Its
   `request/header` tool list contains the preset-only tool and carries the
   template's `config.provider`/`.model`; the parent's own request must carry a
   different route. Its `session/created` title (or the following title event) is
   the `name` the parent passed.
2. The parent's `tool/call` for `subagent` carries `name`, `template`, `prompt`,
   and `run_in_background` — and no `description`, which no longer exists, and no
   omitted background flag, which the schema requires — and its `tool/result` for
   that call carries the child's own final assistant text.
3. With `run_in_background: true` on the call, the parent's log gains a
   `user/message` whose `data.source.kind` is `subagent-settled`, opening with
   `subagent "<name>" finished.` and carrying the child's closing text, with no
   `job_output`/`send_message`/`list_agents` collection call before it. A template
   alone never makes a call run in the background.
4. With the child stopped by an external cause (the teardown case below), the
   process still exits 0 and the parent log has **no** `subagent-settled`
   notice: an external stop settles silently.
5. The plugin's storage domain `subagent_templates` (JSON under the dev home)
   holds a record for the child session id with the right `parentSessionId`,
   `templateId`, and `name`, and a second delegation reusing that name under the
   same parent is refused with a `tool/result` carrying the duplicate error and
   no second child session.
6. The parent's tool set carries `list_subagents`, `message_subagent`, and
   `interrupt_subagent` from its **second** `request/header` onward, and carries
   **no** `list_agents`, `send_message`, `interrupt_agent`, or `subagent_fork` —
   the `personal` preset disables the three native rows for exactly this reason.
   A `list_subagents` call after the delegation reports the child by name with a
   `working` status. A session that never delegates carries only `subagent` and
   `list_subagent_templates`, which its own first `request/header` shows.

A background child outlives the parent's turn in a one-shot run; the mock must
keep the parent alive (e.g. a sleep step) long enough for the child to settle,
otherwise the process exits first and the notice is never delivered or asserted.
The teardown case (requirement 4) is the inverse: let the parent quiesce so the
process unwinds while the child is still live, and assert silence plus a clean
exit.
