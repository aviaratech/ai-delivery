# Contributing to ai-delivery

Use Node 24.21.0 and npm 11.19.0. Work in an isolated checkout. The package
has no access to a particular organization's GitHub Project, credentials or
delivery policy; tests use synthetic repositories and do not mutate live issues.

```sh
npm ci
npm run checks
npm run build
npm pack --dry-run
```

`checks` runs formatting, native type-aware lint, strict TypeScript, a compiled
build and all Vitest tests. CI runs these commands on pull requests and `main`
with a read-only GitHub token. A separate TruffleHog job scans changed Git
history without access to release credentials. Keep examples synthetic and
review `npm pack --dry-run` for every packaged file. Never commit credentials,
host configuration, receipts, logs or repository-specific policy.

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
