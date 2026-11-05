# NewFancyWorld · 可乐吧奇域 V15.2

Community-maintained, independent compatibility implementation of the web-based Qiyu game. **Not affiliated with or endorsed by the original game's rights holders.**

> **Repository setup in progress:** This public repository currently contains release documentation and publishing safeguards. The full source archive is prepared separately and must be reviewed for third-party content before being pushed. No public Windows installer has been released yet.

## What is V15.2?

A Node.js WebSocket/HTTP game server and browser-based front-end integration with systems including combat, maps, items, crafting, shops, professions, social features, auto-hunt and GM administration. Feature completeness is not guaranteed.

### Planned source layout

| Path | Purpose |
| --- | --- |
| `src/` | Game server, accounts, combat, WebSocket, administration |
| `data/` | Gameplay configuration; some source data requires rights review |
| `site/patches/` | Browser-side compatibility patches |
| `test/`, `tools/` | Tests and development tools |
| `launcher/windows/` | Source code for Windows one-click launcher |
| `docs/` | Publication, security and version notes |

### Developer setup (after code is published)

Node.js **18+** is required (Node.js 22 recommended).

```powershell
npm ci
```

The source package **does not include** the large `site.pak` bundle. A full web client also requires front-end assets that you are authorized to use. After these are provided, the recommended safe startup script is `scripts\start-public-safe.bat`.

| Service | Port | Recommended binding |
| --- | --- | --- |
| Game page / WebSocket | 14514 | `0.0.0.0` if sharing with players |
| GM Admin | 19810 | `127.0.0.1` unless protected by HTTPS and access controls |

Avoid exposing the GM admin HTTP service directly to the internet. Do not enable development commands on a public server, and do not publish account save files, certificates or secrets.

## Windows release

The intended asset name is `SSS-Qiyu-V15.2-Win64.exe`. It is roughly 175 MiB and belongs in **GitHub Releases**, not Git history. **No GitHub Release is being claimed as published until the asset is actually uploaded and rights have been reviewed.** The binary uses an **SSS self-signed** signature; this is not a trusted CA signature.

See [v15.2 release notes](docs/RELEASE-v15.2.md) and [publishing instructions](docs/PUBLISHING.md).

## License, rights and attribution

**MIT licensed:** original server source code and associated original server-code documentation authored and owned by SSS may be used, modified, redistributed and used commercially, provided the copyright and MIT license notices are preserved. See [LICENSE](LICENSE).

**Not MIT licensed by this repository:** original Qiyu client/game assets, music, art, maps, proprietary or reverse-engineered third-party data, third-party code, and other contributions not owned by SSS. Distribution of those materials is not authorized by the MIT license. See [asset and rights review](docs/ASSET-AND-LICENSE-REVIEW.md).

**Maintainer:** SSS
