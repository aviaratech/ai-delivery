# ai-delivery plugin

This self-contained Codex and Claude Code plugin bundles the existing `@aviaratech/ai-delivery` CLI and MCP server. Its launcher starts `mcp:serve` from the adjacent `runtime` directory, so the plugin does not need a parent npm installation, source build, or postinstall. Portable `plugin.json` and `mcp.json` files support both hosts; Claude-compatible `.claude-plugin/plugin.json` and `.mcp.json` files remain included. Package, CLI, MCP server, and native manifest versions agree. Application and bundled dependency notices ship with the launcher; MCP schemas, GitHub operations, repository routing, and delivery logic remain owned by the package.

The complete plugin is the canonical public installation for Codex and Claude Code. Its skills cover issue intake, host-owned worktree development, and pull request handoff. Install a published version with:

```sh
ai-delivery plugin install --host codex --scope user --version <published-version>
```

Use `--host claude-code` for Claude Code, with its supported `user`, `project`, or `local` scope. The same command group provides `doctor`, no-write `preview`, explicit-version `update`, `rollback` to the recorded previous version, and `remove`; each accepts `--dry-run` and `--json`. See the [package guide's plugin installation and explicit runtime setup](../../README.md#plugin-installation-and-explicit-runtime-setup) for managed version retention, read-only diagnostics, and data preservation.

Standalone MCP registration is legacy; new consumers should install one complete plugin. CLI, SDK, and MCP entry points remain available. Legacy support lasts at least two subsequent stable releases and 90 days after a qualified migration path first ships. The actual release/date anchor is unknown: this diagnostics phase starts no clock and removes no legacy support.

Remote tools accept explicit `repo` outside a checkout; one server can switch repositories. Roles default from settings without `AI_DELIVERY_IDENTITY`. Hosts own worktrees, checks, commits, and pushes. `runtime:stage`/`runtime:admit` remain separate; plugin installation neither activates private runtimes nor adopts historical custody.

## Preview, activation, and migration

Run `ai-delivery plugin preview --host codex --scope user --json` (or `--host claude-code`) to inspect bounded configuration candidates. Preview starts no native tool or server and creates no settings, backup, lock, or checkpoint. Its migration status is refused, planned changes are empty, and unknown source/version or unavailable scope evidence remain unknown. Codex table-header observations do not identify a TOML/profile/managed resolver; Claude custom-profile configuration remains unverified. Native doctor can observe an external marketplace installation without adopting ownership or starting an unknown launcher. Neither path restores or deletes per-plugin or per-tool preferences.

Installed artifacts, a separate doctor startup, and the conversation's actual loaded version are distinct evidence. Follow [Claude's surface-specific activation guidance](https://code.claude.com/docs/en/discover-plugins) or [Codex's MCP guidance](https://learn.chatgpt.com/docs/extend/mcp); there is no blanket loaded-version or restart claim. Live migration, apply, retirement, and settings rollback remain unavailable until exact authorized ownership, lossless settings preservation, and native writer exclusion are proved. Manifest qualification and actual native migration/adoption remain under [#116](https://github.com/aviaratech/ai-delivery/issues/116). No automatic npm cleanup or mandatory hook is added; directory admission is separate from npm/local-catalog distribution.

## Issue reads and tool discovery

For a remote read, ask in ordinary language, for example: “Use the ai-delivery MCP issue_info tool to read example/widget issue 17. Make no changes and don't use another GitHub tool.” MCP initialization guidance precedes deferred tool discovery. The existing intake skill supports ordinary reading, listing, searching, and authorized intake. A remote read with an explicit repository needs no checkout or typed issue-creation fields.

Carry the named repository into `repo`, discover the intended installed provider, and inspect its schema. In Claude Code, when a bare ai-delivery tool and the installed plugin's tool coexist, the observed plugin-qualified read is `mcp__plugin_ai-delivery_ai-delivery__issue_info` with `{"repo":"example/widget","issueNumber":17}`. This example is host-specific; do not hardcode the name for other clients. A competing `issueNumber`/`cached`-only tool without `repo` has a different contract, and an unsupported field cannot select the repository.

Honor explicit provider, read-only, and MCP-only restrictions. If the requested compatible provider is unavailable, report that without changing directories, using another GitHub provider/CLI, or repairing registration. A successful explicit-repository read demonstrates that read path only; installed files or guidance do not prove provider selection, a running server's version, or host isolation. Native validation should retain the selected tool, schema, arguments, and result, with model/skill context when shown.

## Credentials and readiness

Configure operator-owned JSON at `~/.config/aviaratech-ai/ai-delivery.json` and keep credential values in protected storage, outside source control and plugin/project files. The [package guide](../../README.md#user-configuration) documents the schema and credential flow. For its conventional personal author reference, a missing `GH_TOKEN` may use the machine's active `gh` session; a supplied value takes precedence. A custom reference such as `DELIVERY_AUTHOR_TOKEN` has no fallback. Invalid or denied explicit credentials fail closed. The reviewer App requires `DELIVERY_REVIEWER_APP_ID`, `DELIVERY_REVIEWER_INSTALLATION_ID`, and `DELIVERY_REVIEWER_KEY_PATH`; App authors require their own references. Never substitute an ambient token or the author's credential for the reviewer. Role labels and Git author metadata are not authentication.

The key path must name an absolute private-key file. Missing, ambiguous or expired sessions, selected-user mismatches, or unavailable keyrings refuse without account switching, login/refresh, or added permissions. Unrelated `GITHUB_TOKEN` never replaces the configured reference.

The launcher inherits the native host's environment; it does not read shell profiles, `.env` files, repo config, or a secret manager. Terminal exports may be absent from an already-running GUI host, and configuring a separate CLI does not update that MCP process. Use the host's supported mechanism: [Codex MCP](https://developers.openai.com/codex/mcp) forwards configured `env`/`env_vars`; [Claude Code MCP](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json) expands `${VAR}` only when supplied to the host. OpenAI does not expand Claude `${user_config.*}` plugin options; see [the compatibility guide](https://developers.openai.com/plugins/guides/submit-claude-plugin#replace-claude-userconfig). Do not patch plugin cache or add a competing server to mask missing variables. Restart after changing launch environment and verify from the selected host.

Only `github.com` is supported. Enterprise repositories or conflicting `GH_HOST` fail rather than switching hosts. Supplied `GH_CONFIG_DIR`/`XDG_CONFIG_HOME` remain selected; no alternate profile is tried. `gh` availability and a healthy keyring do not prove native GUI visibility. A selected-runtime CLI pass does not establish GUI propagation, write access, or future reviewer approval. After selecting the exact released plugin, retain a native read-only selected-user/repository result or its actionable missing-gh/session refusal. See the package guide's [reviewer setup](../../README.md#five-minute-reviewer-setup) for App credential and approval details.

Default `plugin doctor` is credential-free: it starts the bundled server and lists tools without contacting GitHub or reading settings, credential references, or keys. To opt in to auth diagnostics, use the intended environment and an explicit repository, even outside Git:

```sh
ai-delivery --repo example/widget plugin doctor --host codex --scope user --check-auth --json
```

Use `--host claude-code` for the managed native selection. Diagnostics refuse absent, disabled, modified, or failed-startup plugins, then validate settings and report missing variable names without values. Missing reviewer/custom references stop before key read or authentication. Credential names must not overlap runtime controls such as `PATH`, `HOME`, host config, or Node/npm/Git variables.

This opt-in probe supervises the selected CLI for 30 seconds and awaits owned cleanup on timeout/cancellation. Unconfirmed cleanup (`probe_cleanup_unverified`) leaves authentication unverified; its `selected_runtime_cli` context does not prove GUI propagation. `--dry-run` neither validates settings nor authenticates.

For direct package CLI readback, run `config:resolve`:

```sh
ai-delivery --repo example/widget config:resolve
```

It reads routing, authenticated author/reviewer App, and visible repository rules without creating an issue, branch, review, or PR. Output keeps raw errors, upstream bodies/headers, tokens, and key paths private. Discovery/auth failure can leave identity/access unknown; it is not a permission diagnosis. Synthetic fixtures validate contracts, not real credentials or native installation. Keep GUI, CLI, and fixture evidence separate; never share values, keys/paths, headers, or raw auth errors.

Inside either host, request actual read-only `issue_info` with a known issue and explicit `repo: "example/widget"`; label it author-only. Full-role `issue_pr_create` with `dryRun: true` requires an existing open issue, a linked branch with readable valid head, default base, and compatible existing PR/issue association. If multiple linked branches exist, name one with `headBranch`; without it, exactly one must be linked. A branch/state refusal may occur before reviewer preflight, so it does not prove credentials invalid. Leave full-role readiness unverified unless the prerequisites and successful dry-run result are available. Do not create a branch or PR to force this diagnostic. See the package guide's [GitHub-gated lifecycle](../../README.md#github-gated-lifecycle).

## Independent reviewer command

See the [package guide's five-minute reviewer setup](../../README.md#five-minute-reviewer-setup) for a consumer-named App profile, explicit provider and actor, and credential source. `ai-delivery review doctor --identity <profile>` checks only that selected App without posting. A fresh independent reviewer writes the strict verdict, then submits it with:

```sh
ai-delivery review submit --pr <number> --head <sha> --identity <profile> --verdict ./verdict.json --repo <owner/name>
```

Approval and request-changes retain their own events and readback states; inspect live required-review status after submission.

The runtime needs no dotenvx or host launcher fork. It reads one selected key in memory, fails closed without fallback, and redacts source errors. Command sources reuse the bounded POSIX supervisor; native Windows commands are deferred, and Windows protected-file permission equivalence is unqualified. Plugin installation does not migrate host credentials or install the optional Claude permission pattern `Bash(ai-delivery review submit *)`. Existing native policies and refusals remain binding.
