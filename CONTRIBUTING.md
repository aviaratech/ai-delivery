# Contributing to ai-delivery

Use an isolated checkout and controller Node **24.21.0** with npm **11.19.0**.
Node **26.2.0** is a separate public-library consumer prerequisite, not a
CLI/controller replacement. Provision with your existing runtime manager and
read back the actual executables (tool installation is a separate action):

```sh
nvm use 26.2.0
export AI_DELIVERY_NODE26_EXECUTABLE="$(node -p 'process.execPath')"
nvm use 24.21.0
node -p 'JSON.stringify({version:process.version,execPath:process.execPath})'
npm --version
"$AI_DELIVERY_NODE26_EXECUTABLE" -p 'JSON.stringify({version:process.version,execPath:process.execPath})'
npm ci --ignore-scripts --no-audit --no-fund
npm run checks
```

The runner fails before gates for missing, wrong or inaccessible prerequisites.
It resolves existing temporary-directory aliases to their physical paths so
macOS synthetic fixtures do not mistake `/var` or `/tmp` aliases for managed
plugin symlinks; this creates no new destination or host setting.
Local and CI full entry `npm run checks` runs `scripts/current-qualification.mjs`:
the canonical six-gate producer, one actual scripts-disabled pack, then an owned,
credential-free production-only consumer installation of that exact archive.
The producer in `scripts/checks.mjs` runs formatting, native type-aware lint,
strict TypeScript, a **clean single build**, all intended compiled Vitest files
with one worker, and complete dry inventory validation. The immutable
`contributor-checks@1` snapshot records those six gates; its `fullSuccess` means
producer success. Overall `ai-delivery.current-qualification@1` requires the
exact archive, resolved production closure, installed byte/mode checks, CLI,
exports, packaged stdio MCP schemas, skills, actual Node26 library use, and owned
quiescent removal. Its `qualified: true` and exit 0 are full contributor proof.
A producer pass alone reports `artifactQualified: false`.
Source names, compiled names and actual Vitest selection must agree;
deleted/renamed tests cannot survive in stale `dist`. Actual artifact qualification
requires a clean committed source including untracked files. Results must be
outside the checkout. CI retains required jobs `checks` and `secrets` and uploads
partial/final evidence, immutable producer logs, and the actual archive.

A serial artifact handoff uses `npm run checks:producer -- --results-dir
/an/owned/new/result-directory`. It runs the producer and actual pack once,
retains `contract.json` and `checkpoint.json`, and returns exit **2** with overall
`incomplete` and the consumer omissions. Resume without rebuilding or repacking:

```sh
npm run checks:resume -- --resume /owned/original/checkpoint.json --results-dir /owned/new/resume-results
```

Resume revalidates clean HEAD/tree, source fingerprint, manifest/lock, all archive
bytes/modes, immutable producer digest, six gates, counts, reviewed skips and
pack quiescence before installation and again before completion. A changed or
incomplete checkpoint fails. For an admitted separate consumer owner, invoke
`node scripts/current-consumer.mjs /owned/original/contract.json
/owned/consumer-result.json --authorize-install` once, then join its retained
result with the same resume command plus `--consumer-result
/owned/consumer-result.json`. That join performs no install, build or pack.
Without `--authorize-install` the helper returns incomplete/exit 2; it cannot
complete overall checks. Immutable receipts are referenced by SHA256 in the
overall result, never inserted back into the producer hash. Do not rerun a
successful producer or pack merely to report or join evidence. Each invocation
needs fresh owned output storage; preserve uncertain/interrupted receipts.

`npm run checks:fast` runs only format/lint/types. It reports `partial-passed`,
`fullSuccess: false` and omitted build/tests/inventory. `npm test` is a separate
development command, not full-check proof. Every check run prints its results
directory and keeps `result.json`, `result.txt`, per-command logs, toolchain/tree,
selected file/test counts, skips, start/final exit, signals and partial state.
Raw test observations survive a failing command and remain distinct from the
validated proof required for full success.
Select owned storage outside the checkout with `npm run checks -- --results-dir
/an/owned/new/result-directory`. Existing results are never overwritten by a
retry. A lost response or missing CI artifact means completion is **unknown**:
inspect the original result and PID/birth records, prove owned quiescence, then
start a fresh attempt. Abrupt process/service loss can prevent final transport.

The reviewed `SKIP_ALLOWLIST` names only two top-level skips. The setup
interruption helper requires passing recovery parents and its receipt; their
launch is distinct from its top-level skip. Absent
`AI_DELIVERY_REAL_PACKAGE_ARCHIVE` (an explicitly supplied path is forwarded
and must not silently become an absent-input skip), the historical reviewed 0.3.4 archive
qualification remains **unexecuted**. That skip, checkout-sharing consumer tests
and dry inventory are not current production-only tarball or native adoption
proof. The reviewed current-tarball consumer is joined by the maintained full entry;
its installation proof remains distinct from the producer and historical archive. Unexpected skips,
exclusions, unknown statuses, missing proof and zero tests fail full checks.

Built-in Node/V8 coverage collects executed **observed V8 ranges** in compiled
library/contributor scripts without a new dependency; it is not TypeScript
source line/branch coverage. Startup collection measures compiled library files,
`scripts/build-plugin.mjs`, and native invocations of the two runners by synthetic
Git hooks. The runners' counters measure those native fixture paths; the main
canonical controller and Vitest-transformed imports are not instrumented. Each
result explicitly lists scripts without any raw measurement as unmeasured,
with no derived floors. For measured files, review staged floors five percentage
points below their first baseline using the same Node/V8 graph before
enforcement; retain these instrumentation limits when assessing those floors.
No arbitrary global 100% threshold or metric-only tests are required.

There is no local total wall-clock deadline. Set an explicit operator-requested
per-command budget with `--command-timeout-ms <milliseconds>` (default 0,
disabled). A timeout is separate from source assertion failure. Cancellation
stops identity-checked owned descendants (including observed separate sessions),
continues discovery from those descendants after the root exits, then uses a
three-second TERM grace before identity-checked KILL and up to one second to
confirm quiescence. Unconfirmed cleanup stays explicit.
Logs are limited to 32 MiB per command and process RSS is sampled against 3 GiB,
not a hard ceiling or model-service measurement. PID/birth observation must work
before launch. CI keeps its existing 15-minute service job limit; interruption
or failed artifact transport requires reconciliation, not a blind retry.

The optional tracked hook is `scripts/pre-commit.mjs`. It copies the index into
an owned temporary directory, honoring `GIT_INDEX_FILE` (including temporary
indexes supplied by `git commit -a` and path-limited commits), computes the exact staged tree with private
objects, materializes that tree, provisions from its staged lock and invokes
its **staged** six-gate canonical producer. The snapshot hook reports actual
archive/clean-HEAD consumer omissions and `artifactQualified: false`; it does not
install or force an uncommitted index through clean-source qualification. It does not stash, write the original index or
unstaged files, or borrow checkout node_modules. It checks the source index for
drift and removes only its owned snapshot after quiescence; results survive.
Unmerged/submodule/symlink index entries fail explicitly. Opt-in installation
in your own checkout only, after inspecting and preserving any existing hook:

```sh
# Do not run on an operator host without explicit operator approval.
hook_path="$(git rev-parse --git-path hooks/pre-commit)"
test ! -e "$hook_path"
printf '%s\n' '#!/bin/sh' 'exec node scripts/pre-commit.mjs' > "$hook_path"
chmod +x "$hook_path"
```

The hook needs the pinned controller/npm PATH and exported actual Node26 path.
Synthetic fixtures prove partial staging, additions, deletions and lockfile
isolation without operator hook installation. Command environments are
allowlisted: credential references, NODE_PATH and ambient NODE_OPTIONS are not
forwarded. Synthetic tests do not mutate live issues. Review the complete
retained inventory; never commit credentials, host configuration, receipts,
logs or repository-specific policy. The separate TruffleHog job scans changed
Git history without release credentials.

The `Publish npm package` workflow is manual, runs only from `main`, and uses
the `npm-publish` environment. Before enabling it, the repository owner must:

1. Confirm the confidentiality review covers the exact source ref and built
   archive. Confirm the MIT license and the exact package repository URL.
2. Protect `main` with counted independent pull request approval, stale-review
   dismissal, strict required `checks` and `secrets` jobs, administrator
   enforcement and no force pushes or deletion. Restrict `npm-publish`
   deployments to the `main` branch. Once the exact guarded workflow and
   environment transition have independent acceptance, the repository owner
   may remove the environment's repeated human reviewer requirement under
   explicit release authority. Preserve all other protection rules and the npm
   trusted-publisher binding; diagnose unexpected settings before changing them.
3. For a new npm package name, have the package owner establish it with a
   separately authorized and reviewed initial version before configuring
   trusted publishing. npm cannot bind a trusted publisher before the package
   exists. Use the protected OIDC workflow for subsequent releases; do not add
   npm credentials to Actions or substitute a token-based workflow.
4. Register `@aviaratech/ai-delivery` with npm trusted publishing for GitHub
   organization `aviaratech`, repository `ai-delivery`, workflow filename
   `release.yml`, and environment name `npm-publish`. Enable direct `npm publish`
   for that trusted publisher. The npm environment restriction must match the
   protected GitHub environment in the workflow.
5. Independently review the exact protected `main` source head, stable package
   version, actual built archive, complete inventory and confidentiality scan.
   Dispatch the workflow on `main` with `reviewed_source_sha`, `package_version`
   and `archive_sha256` from that accepted candidate. Missing or mismatched
   inputs fail closed. The build job checks, scans and packages without OIDC
   permission; only the publish job receives `id-token: write`. It checks the
   downloaded archive against the accepted digest, compares an inert repack
   byte for byte, and rejects observed protected-main or required-check drift
   before publishing through the existing trusted publisher. Inputs are passed
   as environment values, never interpolated into shell commands.

Release dispatch remains an explicit action by the authorized delivery owner;
it does not run on every commit or need a scheduler. Runs serialize through the
`npm-publish` concurrency group. The workflow publishes only an unused stable
version newer than registry `latest`. An occupied version is accepted only when
its actual archive bytes, integrity, provenance metadata and `latest` tag match
the reviewed candidate; it never republishes or retags that version. Registry
errors and conflicting occupied versions fail closed.

npm provenance is generated automatically by trusted publishing only when both
repository and package are public. A release has not occurred merely because
the workflow exists; verify actual registry archive bytes and cryptographic
provenance against the accepted source and artifact after the job finishes. The
workflow checks registry bytes, integrity, provenance metadata and `latest`
after publication, including a failed or ambiguous publish command, and never
automatically retries publication. Read the registry before any explicit retry.
Metadata presence alone does not verify a provenance signature or source identity.

Expected version/archive 404s, missing provenance metadata or package-index entries,
and a lagging stable `latest` tag receive paced read-only reconciliation for up to
five minutes inside the existing ten-minute publish job. Requests retain a
30-second limit, shortened to the remaining reconciliation allowance, with bounded
response bodies and pending-state output. Conflicting evidence, a newer `latest`
tag and authentication/service errors fail immediately. Exhausted reconciliation
or an ambiguous publish result requires read-only qualification of the original
invocation; it never triggers another publication or retag.

Any packaged-file edit, including this guide, changes the release candidate.
Preserve previously accepted archives as evidence and independently qualify a
new exact source/archive before dispatching; never substitute it silently.
