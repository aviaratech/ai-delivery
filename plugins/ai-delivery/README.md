# ai-delivery plugin

Self-contained host plugin for `@aviaratech/ai-delivery`. Its built launcher starts the package's existing `mcp:serve` command in the adjacent `runtime` directory, which includes the built CLI and runtime dependencies. It can start from a native plugin root without a parent npm installation, source build or postinstall. The root contains portable `plugin.json` / `mcp.json` and the preserved Claude-compatible `.claude-plugin/plugin.json` / `.mcp.json`. Package, CLI, MCP server and native manifest versions agree; application and bundled dependency notices accompany the launcher. MCP schemas, GitHub operations, repository routing and delivery logic retain their package owners in the package.

The complete plugin is the canonical public installation for Codex and Claude Code. The bundled skills cover issue intake, host-owned worktree development, and pull request handoff. Use `ai-delivery plugin install --host codex --scope user --version <published-version>` or select `--host claude-code` with a native `user`, `project`, or `local` scope. The same command group provides `doctor`, no-write `preview`, explicit-version `update`, `rollback` to the recorded previous version, and `remove`, with `--dry-run` and `--json` on each. The [package guide](../../README.md) describes managed version retention, read-only diagnostics, and data preservation.

Standalone MCP registration is legacy; new consumers should install one complete plugin. CLI/SDK/MCP entrypoints remain available. Legacy support lasts at least two subsequent stable releases **and 90 days after a qualified migration path first ships**. Its actual release/date anchor is unknown: this diagnostics phase starts no clock and removes no legacy support.

Run `ai-delivery plugin preview --host codex --scope user --json` (or `--host claude-code`) for bounded configuration candidates. Preview invokes no native tool or server and creates no settings, backup, lock or checkpoint. Its migration status is refused, planned changes are empty, and unknown source/version or unavailable scope evidence remain unknown. Codex table-header observations are not a TOML/profile/managed resolver; Claude custom-profile configuration is unverified. Native doctor can observe external marketplace installations without adopting ownership or starting unknown launchers. Neither path restores or deletes per-plugin/per-tool preferences.

Installed artifacts, a separate doctor startup and the conversation's actual loaded version are different evidence. Follow [Claude's surface-specific activation guidance](https://code.claude.com/docs/en/discover-plugins) or [Codex's MCP guidance](https://learn.chatgpt.com/docs/extend/mcp); no blanket loaded-version or restart claim is made. Live migration/apply/retirement/settings rollback remain unavailable until exact authorized ownership, lossless settings preservation and native writer exclusion are proved. Manifest qualification and actual native migration/adoption remain under [#116](https://github.com/aviaratech/ai-delivery/issues/116). No automatic npm cleanup or mandatory hook is added; directory admission is separate from npm/local-catalog distribution.

Configure operator-owned JSON at `~/.config/aviaratech-ai/ai-delivery.json` and provide its selected author/reviewer credential references outside source control. A personal author naming `GH_TOKEN` can use the machine's existing active `gh` session when that variable is absent. Every remote tool accepts an explicit `repo` and works without a checkout or repository policy files; one launched MCP server can switch repositories. The launcher needs no `AI_DELIVERY_IDENTITY`: command roles default from user settings. `issue_pr_create` with `dryRun: true` reports configured actors and rule visibility. Hosts own worktrees, contributor checks, commits and pushes. Explicit `runtime:stage` / `runtime:admit` remain separate controller operations; installing the plugin does not activate or alter a private runtime or adopt historical custody.

## Ordinary issue reads and tool discovery

Ask for the issue in ordinary language, for example “Use the ai-delivery MCP issue_info tool to read example/widget issue 17. Make no changes and don't use another GitHub tool.” The server supplies MCP initialization guidance before deferred tool discovery. The existing intake skill covers ordinary reading, listing and searching as well as authorized intake; no checkout or typed issue-creation fields are needed for a remote read with an explicit repository.

Agents should carry the named repository into `repo`, discover the intended installed provider and inspect its schema. In Claude Code, if a bare ai-delivery tool and the installed plugin's tool coexist, the observed plugin-qualified read is `mcp__plugin_ai-delivery_ai-delivery__issue_info`, called with `{"repo":"example/widget","issueNumber":17}`. This is a host-specific discovery example, not a tool name to hardcode for every client. A competing `issueNumber`/`cached`-only tool without `repo` is a different contract; adding an unsupported field cannot select the repository.

Honor explicit provider, read-only and MCP-only restrictions. If the requested compatible provider is unavailable, report that fact instead of changing directories, using another GitHub provider/CLI or repairing a registration. Successful explicit-repo reads demonstrate that read path; installed files or guidance alone do not prove which provider an agent selected, a running server's version or host isolation. Native validation should retain the actual selected tool, schema, arguments and result, with model/skill context when shown.

## Credentials and readiness

User JSON names credential variables; it does not provide their values. For the
fictional configuration in the [package guide](../../README.md#user-configuration),
the selected personal author names `GH_TOKEN`. When it is absent, the existing
active personal `github.com` session from `gh` is selected. A supplied value takes
precedence; empty, malformed, expired or denied explicit credentials fail without
switching actors. A custom reference such as `DELIVERY_AUTHOR_TOKEN` always
requires its value and has no missing-variable fallback. Ambient `GITHUB_TOKEN`
or unrelated credentials do not replace a configured reference. The reviewer App
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

The author resolver finds `gh` on that actual process PATH, with no hardcoded
installation path, shell-profile launch or current-directory search. It uses
supported `gh auth status --hostname github.com --active --json hosts` and
privately captures `gh auth token --hostname github.com --user <active-user>`.
Status JSON can exit zero despite authentication errors: the selected active
state and actual authenticated user must both pass and match. Inactive account
errors do not invalidate a healthy selected user. Missing/ambiguous/expired
sessions, identity mismatch or unavailable keyring refuse without another
account, login/switch/refresh or a permission grant. Only necessary non-secret
home/PATH/gh configuration selectors reach this child; credentials, debug flags,
injection flags and unrelated environment variables are excluded. The token and
raw stdout/stderr stay private to the selected auth client; no released files,
logs, settings or native diagnostic output receive them.

The package currently supports `github.com` only. An enterprise repository or
conflicting `GH_HOST` fails safely instead of substituting `github.com`.
`GH_CONFIG_DIR` / `XDG_CONFIG_HOME`, when supplied, retain their selected gh
configuration location rather than falling back to another profile. The role's
configured identity is a label; Git author metadata is not authentication.
Actual user/repository readback remains required. Read access does not prove a
future write is allowed or that a reviewer App approval will count.

Shell `gh` availability and a healthy keyring session do not prove native GUI
PATH/keyring visibility. After adopting the exact qualified package in each
host, retain an actual read-only native selected-user/repository readback, or
its actionable missing-gh/session refusal. A selected-runtime CLI pass does not
establish Codex/Claude GUI propagation. Author fallback never substitutes for
the reviewer App's configured credentials or identity.

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

| Layer                                   | Evidence                                                                                             | What remains unproved                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Installed bytes                         | Selected version and matching source integrity                                                       | Server startup and credentials                           |
| Startup                                 | Default `plugin doctor` initializes the bundled server and lists tools without credentials           | Settings validity and GitHub use                         |
| User settings                           | The operator JSON validates its schema, role identities, reference names, and paths                  | Reference availability and authentication                |
| Reference availability                  | Required variables are present; an absent conventional author reference may select the machine route | Token/key/session authentication remains separate        |
| Supplied-environment CLI authentication | Explicit `config:resolve` returns the selected repository, author, reviewer, and rule visibility     | The native GUI/CLI host process received the same inputs |
| Native authentication                   | A read-only tool call succeeds through the selected host's actual MCP process                        | Reviewer approval counts on a later exact PR head        |

Default doctor is credential-free and does not contact GitHub or read user
settings, selected credential variables or keys. To opt in, run from the intended
credential environment with an explicit repository (required even outside Git):

```sh
ai-delivery --repo example/widget plugin doctor --host codex --scope user --check-auth --json
```

Use `--host claude-code` for the corresponding managed native selection. The
diagnostic refuses absent, disabled, modified or failed-startup selections. It
then validates settings and reports required/missing variable names without
values. Eligible absent `GH_TOKEN` is not reported as a required supplied token.
Missing reviewer/custom references or invalid explicit inputs stop before key read or authentication
request. Credential names must not overlap runtime selectors (`PATH`, `HOME`,
host/configuration selectors or Node/npm/Git environment controls).

The verified selected runtime's existing `config:resolve` owns the readback.
Only configured references and necessary selectors are forwarded; an eligible
machine route also retains the process's supported gh home/PATH/config selectors. Unrelated
variables, legacy personal overrides and caller Node injection flags are excluded.
Output separates settings, process references, authenticated author/reviewer,
repository access and visible rules. Authentication/discovery failure can leave
both identity and repository access unverified; a generic failure is not a
permission diagnosis. Raw errors, upstream bodies/headers and private-key paths
are withheld. Rule visibility or App permissions never imply counted approval.
The authentication probe supervises the selected CLI and its children. Its
30-second timeout and host cancellation await owned-process cleanup while
keeping captured output private. If cleanup cannot be confirmed, the result is
`probe_cleanup_unverified` and authentication remains unverified.
The machine author diagnostic includes its safe route/resolved executable. It
does not expose a token or claim a missing variable became present.
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

## Independent reviewer command

The [five-minute reviewer setup](../../README.md#five-minute-reviewer-setup) configures a consumer-named App profile with an explicit provider, actual App actor and one env/default, protected-file or configured-argv credential source. `ai-delivery review doctor --identity <profile>` checks only that selected App without posting. A fresh independent reviewer writes the strict verdict, then uses `ai-delivery review submit --pr <number> --head <sha> --identity <profile> --verdict ./verdict.json --repo <owner/name>`. Both approval and request-changes retain their own events and readback states; inspect live required-review status after submission.

The runtime needs no dotenvx or host launcher fork. It reads one selected key in memory, fails closed without fallback, and redacts source errors. Command sources reuse the bounded POSIX supervisor; native Windows commands are deferred, and Windows protected-file permission equivalence is unqualified. A plugin installation does not migrate host credentials or install the optional Claude permission pattern `Bash(ai-delivery review submit *)`. Existing native policies and refusals remain binding.
