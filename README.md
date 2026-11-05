# NewFancyWorld · 可乐吧奇域 V15.2

Community-maintained, independent compatibility implementation of the web-based Qiyu game. **Not affiliated with or endorsed by the original game's rights holders.**

> **Code published (partial V15.2 distribution):** The repository now contains 130 files of original server code, tests, launcher source and project support files. Client-derived maps/data, art, audio, `site.pak`, front-end patch bundles and the Windows installer are intentionally not published here. Five secondary build-helper files remain outside the repository. **This source-only checkout is not a complete, ready-to-play distribution.**

## What is V15.2?

A Node.js WebSocket/HTTP game server and browser-based front-end integration with systems including combat, maps, items, crafting, shops, professions, social features, auto-hunt and GM administration. Feature completeness is not guaranteed.

### Published source layout

| Path | Purpose |
| --- | --- |
| `src/` | Game server, accounts, combat, WebSocket, administration |
| `data/` | **Not published**: derived game datasets need rights review |
| `site/patches/` | **Not published yet**: front-end patches need rights review |
| `test/`, `tools/` | Tests and one build utility; five other build utilities pending |
| `launcher/windows/` | Source code for Windows one-click launcher |
| `docs/` | Publication, security and version notes |

### Developer setup (source-only checkout)

Node.js **18+** is required (Node.js 22 recommended).

```powershell
npm ci
```

This repository **does not include** the large `site.pak` bundle **or required game datasets**. A full game needs both front-end assets and data you are authorized to use. After supplying these dependencies, the recommended safe startup script is `scripts\start-public-safe.bat`. The Windows launcher source also needs the separately prepared game payload for a complete EXE build.

| Service | Port | Recommended binding |
| --- | --- | --- |
| Game page / WebSocket | 14514 | `0.0.0.0` if sharing with players |
| GM Admin | 19810 | `127.0.0.1` unless protected by HTTPS and access controls |

Avoid exposing the GM admin HTTP service directly to the internet. Do not enable development commands on a public server, and do not publish account save files, certificates or secrets.

## Releases

The `v15.2` release is planned as a **source-only preview** of the reviewed repository snapshot; it is not a runnable Windows game distribution. GitHub provides source ZIP and TAR archives automatically when the release is published. [Check the actual release status](https://github.com/skyjokersun/NewFancyWorld/releases).

The separately prepared `SSS-Qiyu-V15.2-Win64.exe` is roughly 175 MiB and **has not been uploaded**, since it embeds archived game resources requiring redistribution-rights review. Its self-signed `CN=SSS` signature does not make it a trusted Windows publisher.

See [v15.2 release notes](docs/RELEASE-v15.2.md) and [publishing instructions](docs/PUBLISHING.md).

## License, rights and attribution

**MIT licensed:** original server source code and associated original server-code documentation authored and owned by SSS may be used, modified, redistributed and used commercially, provided the copyright and MIT license notices are preserved. See [LICENSE](LICENSE).

**Not MIT licensed by this repository:** original Qiyu client/game assets, music, art, maps, proprietary or reverse-engineered third-party data, third-party code, and other contributions not owned by SSS. Distribution of those materials is not authorized by the MIT license. See [asset and rights review](docs/ASSET-AND-LICENSE-REVIEW.md).

**Maintainer:** SSS
