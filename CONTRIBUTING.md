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
2. Protect `main` and the `npm-publish` environment with required reviewers,
   restricted deployment branches and no self-review. Require both CI jobs.
3. For a new npm package name, have the package owner establish it with a
   separately authorized and reviewed initial version before configuring
   trusted publishing. npm cannot bind a trusted publisher before the package
   exists. Keep the `0.1.0` release for the protected OIDC workflow; do not add
   npm credentials to Actions or substitute a token-based workflow.
4. Register `@aviaratech/ai-delivery` with npm trusted publishing for GitHub
   organization `aviaratech`, repository `ai-delivery`, workflow filename
   `release.yml`, and environment name `npm-publish`. Enable direct `npm publish`
   for that trusted publisher. The npm environment restriction must match the
   protected GitHub environment in the workflow.
5. Review the source head, package version, archive inventory and secret scan.
   Dispatch the release workflow on `main` once. The build job checks and
   packages without OIDC permission; only the approved publish job receives
   `id-token: write` and publishes that archived tarball.

npm provenance is generated automatically by trusted publishing only when both
repository and package are public. A release has not occurred merely because
the workflow exists; verify npm registry readback after the protected job
finishes. A failed or ambiguous publish requires registry readback before retrying
the same version.
