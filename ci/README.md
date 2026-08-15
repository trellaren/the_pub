# Check gate

GitHub Actions is switched off for this repository on purpose — it costs more
than it is worth here — and it is staying off. There is no workflow file
anywhere in this repo, dormant or otherwise. The checks that would normally be
CI live here instead, as a self-contained script you run deliberately before a
merge.

Nothing in this directory runs on its own, and nothing here bills anybody.

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
| `--skip-package` | Skip packaging and the packaged smoke test |

It runs, in order: `npm ci` → `npm run typecheck` → `npm test` → `npm run build`
→ `npm run e2e` → `npm run package` → `npm run e2e:packaged`. A failure stops the
run and marks everything after it *skipped* rather than passed.

The last two are what separate "the code works" from "the thing someone installs
works". Nothing before them touches the asar archive, the pruned production
`node_modules` inside it, or the real executable's own profile directory — so a
dependency that stopped being shipped would break Word export and SFTP in a
release and in nothing else.

The end-to-end stage stands up real servers rather than fakes: `ftp-srv` for
FTP, and `ssh2`'s own server for SFTP. Both serve a temporary directory over
loopback, so the gate needs no network access and nothing installed — but a
sandbox that forbids listening on `127.0.0.1` will fail those tests rather than
skip them, which is the intended behaviour. The SFTP server takes an
OS-assigned port; the FTP one derives a fixed port from the process id, because
passive mode makes a server advertise its own address.

## Why it clones

The script makes a full clone of the repository into a throwaway directory,
checks out the ref there and runs everything against that copy, rather than in
your working copy. Full, not shallow: the clone carries the whole object store
and every branch, so `--ref` can name any commit, branch or tag you have.

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
- On Windows and macOS the two Playwright stages run directly. Only Linux can be
  genuinely headless, so that is the only case where they are wrapped in
  `xvfb-run` — and if there is no display and no `xvfb-run`, they are reported as
  **skipped**, never as passed.
- **The gate packs with `--dir`, not `dist`.** An unpacked app is the only
  packaging step that works on all three hosts with no extra tooling: the
  Windows NSIS installer needs Wine on Linux, the macOS DMG needs macOS, and
  signing needs certificates nobody has here. So the gate proves the app *packs
  and runs*, not that every installer builds. See the README's release section.
- The packaging stage writes a few hundred megabytes of `release/` into the
  throwaway clone, and adds a minute or two. `--skip-package` is there for when
  that is not what you are checking.
- Installing LibreOffice widens the gate: one end-to-end test converts an
  exported `.docx` with it, which is the only check that a real, independent
  OOXML implementation accepts what this app writes. Without it that test
  reports as skipped.
- On Windows, run it from Git Bash (or WSL). `.gitattributes` keeps the script
  checked out with LF endings, which bash requires.
- The script is plain bash and git, so it runs anywhere the project builds —
  a laptop, a build box, or some other CI system later — without carrying a
  dependency on any particular CI product.
