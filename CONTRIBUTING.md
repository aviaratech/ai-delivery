# Contributing to ai-delivery

Use an isolated worktree and follow [repository policy](AGENTS.md) and existing host permissions. Tool installation, hook setup and host activation require separate authorization.

The controller requires Node **24.21.0** and npm **11.19.0**. Node **26.2.0** is a distinct public-library consumer prerequisite. With both runtimes already installed:

```sh
nvm use 26.2.0
export AI_DELIVERY_NODE26_EXECUTABLE="$(node -p 'process.execPath')"
nvm use 24.21.0
node --version
npm --version
"$AI_DELIVERY_NODE26_EXECUTABLE" --version
# Explicit dependency setup, when missing or incompatible:
npm ci --ignore-scripts --no-audit --no-fund
```

Missing or incompatible prerequisites stop checks; the runner never installs dependencies implicitly.

Run fast checks with an explicit selection for the changed contracts and fresh owned results outside the checkout:

```sh
npm run checks:fast -- --test-file dist/contributorChecks.test.js --test-file dist/stagedChecks.test.js --results-dir /owned/new/local-results
```

Choose files deliberately. Add `--build-plugin` only when selected contracts require the bundle. Real-install/archive cases belong to qualification. Do not run the full local suite per change. See [runner options](scripts/checks.mjs) and the [optional staged hook](scripts/pre-commit.mjs).

Existing [GitHub CI](.github/workflows/ci.yml) runs `npm run checks`. Merge requires current independent review and green required `checks`/`secrets` on the candidate and current base; local results cannot replace them. Inspect retained results and prove owned quiescence before retrying uncertain operations.

Fast/focused success never qualifies a package. [Qualification](scripts/current-qualification.mjs) and [publication](.github/workflows/release.yml) are separate, explicitly authorized stages. Publication consumes independently accepted source/version/archive and the original successful artifact. Preserve confidentiality, archive, cleanup and host-policy gates; never substitute later reruns or silently replace accepted archives. Any packaged-file edit, including this guide, changes the candidate and requires independent qualification before release.
