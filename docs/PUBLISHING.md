# V15.2 publication status / 发布状态

As of November 2026, **130 reviewed source and support files have been committed to `main`**, including original server modules, tests, and the Windows launcher source code. This is **not** the complete runnable game.

## Still not published

- The large `site.pak` client bundle and all third-party game images, sounds, and music.
- Client-derived datasets under `data/`, including maps and catalog exports.
- Front-end patches under `site/patches/` and `frontend-patch/`, pending content/rights review.
- The Windows EXE, because it includes archived game resources.
- Five auxiliary development tools: `tools/build-named-index.js`, `tools/catalog-lib.js`, `tools/pack-site.js`, `tools/site-files.js`, `tools/sysload.js`.

The original full project package and filtered original source-only archive are available to the maintainer in the ChatGPT project conversation. A GitHub Actions workflow is configured to publish the reviewed repository snapshot as a **source-only** `v15.2` prerelease; see the [Releases page](https://github.com/skyjokersun/NewFancyWorld/releases) for actual status. The automatically generated GitHub source ZIP/TAR archives will contain only the source present in the tagged commit.

## Upload remaining reviewed source files

If you have the necessary rights to redistribute additional files, use a local Git client and review each path before pushing:

```powershell
git clone https://github.com/skyjokersun/NewFancyWorld.git
cd NewFancyWorld
# Copy reviewed files into this working tree.
git status
git add -- <reviewed-paths>
git diff --cached --stat
git commit -m "Add additional reviewed V15.2 source"
git push origin main
```

Never add `var/state.json`, administrator passwords, keys, tokens, `node_modules/` or private player records.

## Windows EXE

Only after verifying redistribution rights for all bundled resources may a Windows EXE be attached to the GitHub Release. **No EXE is included in the source-only prerelease.** Do not add it to the Git repository history. See [release notes](RELEASE-v15.2.md) and [rights review](ASSET-AND-LICENSE-REVIEW.md).

GitHub hosts code and release downloads; it does not keep a Node.js game server continuously running.
