# Check gate

GitHub Actions is switched off for this repository on purpose — it costs more
than it is worth here — and it is staying off. So the checks that would normally
be CI live here instead, as something you run deliberately before a merge.

Nothing in this directory runs on its own. GitHub only auto-discovers workflows
in `.github/workflows/`, and that directory does not exist.

## Running the gate

```sh
bash ci/run-checks.sh              # check the current commit
bash ci/run-checks.sh --ref main   # check some other ref
```

| Flag | Effect |
|---|---|
| `--ref <git-ref>` | Commit, branch or tag to check (default: `HEAD`) |
| `--keep` | Keep the temporary clone even on success |
| `--skip-e2e` | Typecheck, unit tests and build only |

It runs, in order: `npm ci` → `npm run typecheck` → `npm test` → `npm run build`
→ `npm run e2e`. A failure stops the run and marks everything after it *skipped*
rather than passed.

## Why it clones

The script checks out the ref into a throwaway directory and runs everything
there, rather than in your working copy.

Running in place would reuse the existing `node_modules/` and `out/`, so it can
pass on a tree that would not build for anybody else — a file you forgot to
`git add`, a dependency you installed but never added to `package.json`. A clone
contains only committed history, so those failures surface here instead of after
a merge.

For the same reason the script prints a warning, and repeats it in the summary,
when your working tree is dirty: **those changes are not being checked.**

The clone is deleted on success and kept on failure, with its path printed — a
failed run's copy is the thing worth poking at.

## Notes

- The first run downloads Electron (~100 MB). Later runs hit the npm cache and
  `~/.cache/electron`, so they are much faster.
- The build must precede the end-to-end tests: Playwright launches the *built*
  app, and nothing in the npm scripts enforces that ordering.
- On a headless machine the end-to-end stage is wrapped in `xvfb-run`. If there
  is no display and no `xvfb-run`, the stage is reported as **skipped**, never
  as passed.

## The dormant workflow

`ci/workflow.yml` is the same pipeline written as a GitHub Actions workflow. It
is inert where it sits. If Actions ever becomes worth enabling:

```sh
cp ci/workflow.yml .github/workflows/checks.yml
```

It is `workflow_dispatch` only — triggered by hand from the Actions tab, never
on push or pull request. Add those triggers deliberately, knowing the cost.
