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
# Explicit initial dependency setup, when missing or incompatible:
npm ci --ignore-scripts --no-audit --no-fund
```

For each ordinary change, run fast checks plus an explicit focused selection
for the changed contracts, using fresh owned results outside the checkout:

```sh
npm run checks:fast -- --test-file dist/contributorChecks.test.js --test-file dist/stagedChecks.test.js --results-dir /owned/new/local-results
```

This runs format/lint/native TypeScript checking, one clean esbuild JavaScript
emit and only the selected compiled test files. Add `--build-plugin` only when those selected contracts
need the bundled plugin artifact. Select tests deliberately: an existing mixed
file can contain real npm installation/archive cases, which are not ordinary
local validation. The local runner never implicitly provisions dependencies,
packs an archive or selects every test. Do not run the full local suite per
change. Required green CI for the current independently reviewed candidate and
current base is the merge gate; missing, failed or stale required CI cannot be
replaced by local results. Preserve old full-local failures as diagnostic history;
they do not create a blanket additional merge prerequisite.

The runner fails before gates for missing, wrong or inaccessible prerequisites.
It resolves existing temporary-directory aliases to their physical paths so
macOS synthetic fixtures do not mistake `/var` or `/tmp` aliases for managed
plugin symlinks; this creates no new destination or host setting.
The PR entry `npm run checks`, used by current CI, runs `scripts/checks.mjs`:
formatting, native type-aware lint, strict native TypeScript with declaration-only
emit, a **clean single JavaScript/plugin build** through esbuild,
all intended PR cases directly from `src/**/*.test.ts`, and complete
dry inventory validation. Release cases are excluded by the native `release`
tag and the default test configuration, including direct focused invocations.
Vitest uses isolated fork workers sized by `availableParallelism()` for both source
and admitted compiled release files. Files own separate temporary roots; mutable
test ports and environment changes remain inside each worker. Native TypeScript
7 runs once for the producer's declarations; esbuild does not repeat type analysis.
Formatting and type-aware lint use their default worker counts. The default test
timeout remains 60 seconds. Existing case-specific operation and drain bounds remain;
the existing 15-minute CI job limit is the backstop for native blocking.
The immutable
`contributor-checks@1` snapshot records those six gates; its `fullSuccess` means
PR producer success. It reports `artifactQualified: false` and explicitly records
the release omissions; it does not pack or install a candidate archive.

Explicit `npm run checks:release -- --results-dir /owned/new/release-results`
runs `scripts/current-qualification.mjs`: the same PR producer, one actual
scripts-disabled candidate pack, the exact reviewed mandatory release inventory in
`scripts/checks.mjs`, then
an owned, credential-free production-only consumer installation of that exact
archive. Only the existing qualification contract can enable the release lane;
setting a lane variable or supplying an arbitrary path cannot authorize it.
Both packed test helpers copy the original archive instead of packing again.
The release inventory includes native Git, process, cancellation, credential-probe,
CLI, interruption and installation contracts moved from the regular lane. Case
identities and tags are checked together; relocation preserves their assertions.
Setup producer and CLI scenarios share one fixture and run in separate files.
The release cases retain their existing synthetic fixture installations;
these are distinct from the final current-archive production installation.
Overall `ai-delivery.current-qualification@1` requires complete release tests,
the exact archive, resolved production closure, installed byte/mode checks, CLI,
exports, packaged stdio MCP schemas, skills, actual Node26 library use, and owned
quiescent removal. Its `qualified: true` and exit 0 are full package qualification
proof, distinct from ordinary local fast/focused evidence.
Source names, compiled names and actual Vitest selection must agree;
deleted/renamed tests cannot survive in stale `dist`. Actual artifact qualification
requires a clean committed source including untracked files. Results must be
outside the checkout. CI retains required jobs `checks` and `secrets` and uploads
partial/final PR evidence and immutable producer logs. Explicit qualification
retains its actual archive separately. Count the one producer build, dry inventory,
one candidate pack, release fixture installs, production install and any later
inert comparison pack separately; a fixture or dry run is not candidate proof.

A serial artifact handoff uses `npm run checks:producer -- --results-dir
/an/owned/new/result-directory`. It runs the producer and actual pack once,
retains `contract.json` and `checkpoint.json`, and returns exit **2** with overall
`incomplete` and the release/consumer omissions. Resume without rebuilding or repacking:

```sh
npm run checks:resume -- --resume /owned/original/checkpoint.json --results-dir /owned/new/resume-results
```

Resume revalidates clean HEAD/tree, source fingerprint, manifest/lock, all archive
bytes/modes against member SHA256s captured inside the successful producer,
immutable producer digest, six gates, counts, reviewed skips and
pack quiescence before installation and again before completion. A changed or
incomplete checkpoint fails. Release tests reserve checkpoint-owned
`release-tests-attempt.json` before any child. The scoped report runs only tests,
retains exact case identities and contract/source/archive joins, and reports
`fullSuccess: false` and `artifactQualified: false`. It removes only its owned
temporary root after command quiescence, on success, failure and cancellation.
An uncertain attempt blocks resume even with fresh outer results. Resume reuses
a compatible completed release result. A terminal failed/cancelled attempt with
proven quiescence and temporary removal can be retired by the owning resume path:
its exact original metadata remains in `retired-attempt.json` before a new
exclusive attempt begins. A lost retirement acknowledgement or changed cleanup
identity requires owner reconciliation. Partial test assertions are never reused.
The new outer result references original producer, pack, release and consumer
evidence without rewriting their completed receipts.

Consumer launch is supervised and reserves one
checkpoint-wide `consumer-attempt.json` before starting a child. It retains the
command, observed PID/birth identities, logs and owned temporary root during
execution. An unresolved attempt blocks another install even with fresh overall
results storage. After controller loss, `--reconcile-consumer` joins an already
qualified retained receipt only after every observed identity is absent; it
does not launch or kill a process. Missing launch identity, incomplete receipts,
active processes or leftover temporary contents require owner reconciliation.
A completed retained consumer is reused without installation. For an admitted
separate consumer owner, prefer the supervised resume entry. If its independently
supervised invocation retains equivalent launch and cleanup proof, invoke
`node scripts/current-consumer.mjs /owned/original/contract.json
/owned/consumer-result.json --authorize-install` once, then join its retained
result with the same resume command plus `--consumer-result
/owned/consumer-result.json`. That join performs no install, build or pack.
Without `--authorize-install` the helper returns incomplete/exit 2; it cannot
complete overall checks. Immutable receipts are referenced by SHA256 in the
overall result, never inserted back into the producer hash. Do not rerun a
successful producer or pack merely to report or join evidence. Each invocation
needs fresh owned output storage; preserve uncertain/interrupted receipts.

Plain `npm run checks:fast` runs only format/lint/types. It reports `partial-passed`,
`fullSuccess: false` and omitted build/tests/inventory. With repeatable exact
`--test-file dist/path.test.js` arguments, it reports `scope: focused`, retains
the actual selection/commands and omits unselected tests, inventory and package
proof. Empty, duplicate, missing or glob selections refuse; they never fall back
to all tests. Both local modes retain `artifactQualified: false`. `npm test` is a separate
development command, not full-check proof. Every check run prints its results
directory and keeps `result.json`, `result.txt`, per-command logs, toolchain/tree,
selected file/test counts, skips, start/final exit, signals and partial state.
Raw test observations survive a failing command and remain distinct from the
validated proof required for full success.
Select owned storage outside the checkout with `npm run checks:fast -- --results-dir
/an/owned/new/result-directory`. Existing results are never overwritten by a
retry. A lost response or missing CI artifact means completion is **unknown**:
inspect the original result and PID/birth records, prove owned quiescence, then
start a fresh attempt. Abrupt process/service loss can prevent final transport.

The reviewed `SKIP_ALLOWLIST` names three top-level release skips. The setup
interruption helper requires passing recovery parents and its interruption receipt.
The separate CLI preparation helper requires passing CLI/preparation parents and
its phase receipt. Each helper remains in the exact release inventory; its owned
child launch is distinct from its top-level skip. Absent
`AI_DELIVERY_REAL_PACKAGE_ARCHIVE` (an explicitly supplied path is forwarded
and must not silently become an absent-input skip), the historical reviewed 0.3.4 archive
qualification remains **unexecuted** in the release lane. It remains excluded in
the PR lane even when historical input is supplied. No archive is fabricated or
substituted for missing historical input. That skip, checkout-sharing consumer tests
and dry inventory are not current production-only tarball or native adoption
proof. The reviewed current-tarball consumer is joined by the explicit release entry;
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
objects, materializes that tree and invokes its **staged** fast/focused runner.
Supply a nonempty explicit selection using repeatable `--test-file` arguments
for direct invocation, or Git's no-argument hook with a JSON array:

```sh
AI_DELIVERY_FOCUSED_TESTS='["dist/stagedChecks.test.js","dist/contributorChecks.test.js"]' git commit
```

The hook reuses compatible installed dependencies through links under an owned
`node_modules` parent, keeping tool caches and outputs in owned storage. It checks
installed metadata and actual package versions against the **staged** lock,
requires its dependency declarations to match the staged manifest, and uses
read-only `npm ls --package-lock-only` to validate that lock's graph. This avoids
npm treating linked dependencies as development projects. Unrelated unstaged
manifest/lock changes are preserved.
Missing/incompatible setup or observable dependency metadata drift refuses;
the hook never installs or repairs dependencies and does not copy their payload.
This is local compatibility evidence, not installed-byte/package provenance.
The snapshot hook reports `partial-passed`, `fullSuccess: false`, actual
archive/clean-HEAD consumer omissions and `artifactQualified: false`. It does
not stash, write the original index or unstaged files. It checks the source index for
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
Its selection input is consumed once and forwarded as exact arguments to the
sanitized staged child. A selected contract requiring plugin bundling also needs
an explicit `--build-plugin` argument in the hook invocation.
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
5. Independently review the exact protected `main` source head and stable package
   version, then first dispatch the same workflow on `main` with
   `qualification_only=true`, `reviewed_source_sha` and `package_version`.
   Leave `archive_sha256` and `qualification_artifact_id` empty. This mode runs
   `checks:release` once, scans source history and uploads immutable
   `npm-qualified-<run_attempt>` evidence with one-day retention; publication is
   skipped. Selection observes the archive digest from the completed original
   contract and bytes. Its summary reports that digest and the native artifact ID.
   Independently accept the actual source/version/digest, complete inventory,
   release/consumer/cleanup proof, confidentiality scan and exact native artifact
   ID before promotion. Missing evidence or an expired artifact is not acceptance.
6. For separately authorized publication, dispatch with `qualification_only=false`
   and the accepted `reviewed_source_sha`, `package_version`, `archive_sha256`
   and `qualification_artifact_id`. The package job verifies the artifact's fixed
   repository, workflow, source and original successful run attempt, downloads
   that exact artifact ID, and verifies original portable receipts and bytes.
   It does not rebuild, repack, install or rerun qualification. A successful later
   rerun cannot substitute for a failed original attempt. Missing or mismatched
   inputs fail before costly commands; there is no absent-proof fallback.
   Both package modes have read permissions and no OIDC; only the publish job
   receives `id-token: write`. The publish job checks the portable receipt and
   downloaded archive against the accepted source/version/digest, compares an inert repack
   byte for byte, and rejects observed protected-main or required-check drift
   before passing the verified tarball path directly to `npm publish` through the
   existing trusted publisher. The inert repack is a byte comparison only;
   its output never becomes the upload or publication source. Receipt hashes
   preserve evidence integrity; reviewed workflow source and its actual execution
   remain necessary provenance. Inputs are passed
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
