# ai-delivery plugin

Self-contained host plugin for `@aviaratech/ai-delivery`. Its built launcher starts the package's existing `mcp:serve` command in the adjacent `runtime` directory, which includes the built CLI and runtime dependencies. It can start from a native plugin root without a parent npm installation, source build or postinstall. The root contains portable `plugin.json` / `mcp.json` and the preserved Claude-compatible `.claude-plugin/plugin.json` / `.mcp.json`. Package, CLI, MCP server and native manifest versions agree; application and bundled dependency notices accompany the launcher. MCP schemas, GitHub operations, repository routing and delivery logic retain their package owners in the package.

The bundled skills cover issue intake, host-owned worktree development, and pull request handoff. Use `ai-delivery plugin install --host codex --scope user --version <published-version>` or select `--host claude-code` with a native `user`, `project`, or `local` scope. The same command group provides `doctor`, explicit-version `update`, `rollback` to the recorded previous version, and `remove`, with `--dry-run` and `--json` on each. The [package guide](../../README.md) describes managed version retention, read-only diagnostics, and data preservation. Restart the host after changing its plugin selection.

Configure operator-owned JSON at `~/.config/aviaratech-ai/ai-delivery.json` and set its author/reviewer credential environment references outside source control. Every remote tool accepts an explicit `repo` and works without a checkout or repository policy files; one launched MCP server can switch repositories. The launcher needs no `AI_DELIVERY_IDENTITY`: command roles default from user settings. `issue_pr_create` with `dryRun: true` reports configured actors and rule visibility. Hosts own worktrees, contributor checks, commits and pushes. Explicit `runtime:stage` / `runtime:admit` remain separate controller operations; installing the plugin does not activate or alter a private runtime or adopt historical custody.

## Credentials and readiness

User JSON names credential variables; it does not provide their values. For the
fictional configuration in the [package guide](../../README.md#user-configuration),
the selected personal author needs `DELIVERY_AUTHOR_TOKEN`. The reviewer App
needs `DELIVERY_REVIEWER_APP_ID`, `DELIVERY_REVIEWER_INSTALLATION_ID`, and
`DELIVERY_REVIEWER_KEY_PATH`; the last value names an absolute private-key file.
An App author needs its own three references. Role identities, reference names,
and authenticated actors must remain distinct. Never substitute an ambient token
or the author's credential for the reviewer.

The bundled launcher inherits the environment supplied by the native host. It
does not automatically read a shell profile, `.env` file, repository configuration,
or secret manager. A variable exported in a terminal may be absent from an
already-running GUI application. Supplying variables to a separate CLI command
does not change the native host's running MCP process.

Use an operator-controlled, host-supported environment mechanism for the selected
server and the configured reference names. [Codex's stdio configuration](https://developers.openai.com/codex/mcp)
supports per-server `env` and allow-and-forward `env_vars`; forwarding requires
the named input to exist in the selected local or remote environment.
[Claude Code's MCP configuration](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json)
supports `${VAR}` expansion in server environment fields. Expansion also requires
the input to exist; an unresolved placeholder is not a supplied credential.
These mechanisms configure the host boundary, rather than importing consumer
policy. OpenAI does not expand Claude's `${user_config.*}` plugin options, so
those prompts are not a shared setup path for both hosts.
[OpenAI's compatibility guide](https://developers.openai.com/plugins/guides/submit-claude-plugin#replace-claude-userconfig)
describes this limitation.

Keep values in the operator's protected credential storage and out of plugin
manifests, released cache files, project settings, transcripts, and diagnostic
output. Select only the configured delivery references; do not export a whole
credential file or unrelated service variables. A scoped launcher may retain
ordinary inherited process variables: that is different from proving the entire
environment is sanitized. Restart the selected host after changing its launch
environment, then verify from that host. Native per-server setup must retain the
selected released plugin; do not patch its cache or add a competing server to
hide a missing-variable failure.

Treat each readiness layer separately:

| Layer                                   | Evidence                                                                                         | What remains unproved                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Installed bytes                         | Selected version and matching source integrity                                                   | Server startup and credentials                           |
| Startup                                 | Default `plugin doctor` initializes the bundled server and lists tools without credentials       | Settings validity and GitHub use                         |
| User settings                           | The operator JSON validates its schema, role identities, reference names, and paths              | Reference availability and authentication                |
| Reference availability                  | Named variables are present and valid for the selected roles; report missing names only          | A token or key may still be invalid or inaccessible      |
| Supplied-environment CLI authentication | Explicit `config:resolve` returns the selected repository, author, reviewer, and rule visibility | The native GUI/CLI host process received the same inputs |
| Native authentication                   | A read-only tool call succeeds through the selected host's actual MCP process                    | Reviewer approval counts on a later exact PR head        |

Default doctor is credential-free and does not contact GitHub or read user
settings, selected credential variables or keys. To opt in, run from the intended
credential environment with an explicit repository (required even outside Git):

```sh
ai-delivery --repo example/widget plugin doctor --host codex --scope user --check-auth --json
```

Use `--host claude-code` for the corresponding managed native selection. The
diagnostic refuses absent, disabled, modified or failed-startup selections. It
then validates settings and reports required/missing variable names without
values. Missing or invalid references stop before any key read or authentication
request. Credential names must not overlap runtime selectors (`PATH`, `HOME`,
host/configuration selectors or Node/npm/Git environment controls).

The verified selected runtime's existing `config:resolve` owns the readback.
Only configured references and necessary selectors are forwarded; unrelated
variables, legacy personal overrides and caller Node injection flags are excluded.
Output separates settings, process references, authenticated author/reviewer,
repository access and visible rules. Authentication/discovery failure can leave
both identity and repository access unverified; a generic failure is not a
permission diagnosis. Raw errors, upstream bodies/headers and private-key paths
are withheld. Rule visibility or App permissions never imply counted approval.
The invocation context is `selected_runtime_cli`, and native GUI propagation
remains `unverified`. Dry-run does not validate settings or authenticate.

For a direct package CLI readback, the existing command is:

```sh
ai-delivery --repo example/widget config:resolve
```

This command uses the existing configuration and GitHub clients to read routing,
the authenticated author and reviewer App, and visible repository rules. It does
not create an issue, branch, review, or PR. A failure such as a missing author
variable must not be reported as authenticated readiness even if startup passed.
Successful reviewer access also does not establish counted approval; that needs
readback after an exact-head review is submitted.

Inside Codex or Claude Code, request an actual read-only `issue_info` call with a
known issue and explicit `repo: "example/widget"`. Label this native author-only
readback accurately. For a full role preflight, `issue_pr_create` with
`dryRun: true` also requires an existing open issue and a GitHub-linked branch
in the selected repository with a readable valid head. Without `headBranch`,
exactly one linked branch must be available; when several exist, pass
`headBranch` naming one of those linked branches. The base must be the repository
default branch, and any matching existing PR must have compatible state and
readable issue association. Check the configured author, reviewer and rule
visibility only after the dry-run succeeds.

A branch or issue/PR-state refusal can occur before reviewer preflight; it does
not establish that credentials are invalid. If the prerequisites or successful
dry-run result are unavailable, leave native full-role readiness unverified.
Keep any author-only native readback or separate CLI preflight labelled with its
own evidence context. Do not create a branch or PR to force this diagnostic.
Repeat for another explicitly selected repository when cross-repository access
is required; an outside-Git launch and repository switching require no consumer
policy files.

Record the host, selected version, repository, check, outcome, missing variable
names, and safe actor identifiers. Keep native GUI results, native CLI results,
supplied-environment package CLI results, and synthetic fixtures in separate
evidence categories. A fictional fixture validates a contract, not a real
credential or native installation. Do not include environment values, private
keys, private-key paths, headers, or raw authentication errors in shared reports.
