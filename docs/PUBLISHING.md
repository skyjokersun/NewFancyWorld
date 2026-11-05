# V15.2 publication status / 发布状态

As of November 2026, **130 reviewed source and support files have been committed to `main`**, including original server modules, tests, and the Windows launcher source code. This is **not** the complete runnable game.

## Still not published

- The large `site.pak` client bundle and all third-party game images, sounds, and music.
- Client-derived datasets under `data/`, including maps and catalog exports.
- Front-end patches under `site/patches/` and `frontend-patch/`, pending content/rights review.
- The Windows EXE, because it includes archived game resources.
- Five auxiliary development tools: `tools/build-named-index.js`, `tools/catalog-lib.js`, `tools/pack-site.js`, `tools/site-files.js`, `tools/sysload.js`.

The original project package and the filtered source-only archive are available to the maintainer in the ChatGPT project conversation, **not** as public GitHub downloads. No GitHub Release has been published.

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

After verifying redistribution rights for bundled resources, create GitHub Release tag `v15.2` and attach the Windows EXE **to that Release only**. Do not add it to the Git repository history. See [release notes](RELEASE-v15.2.md) and [rights review](ASSET-AND-LICENSE-REVIEW.md).

GitHub hosts code and release downloads; it does not keep a Node.js game server continuously running.
