# NewFancyWorld V15.2 — Source-only Preview / 源码预览版

**This is a source-code prerelease, not a fully playable game or a Windows installer.**
**这是源码预览版，不包含可直接运行的游戏客户端或 Windows EXE。**

### Included / 已包含

- Reviewed Node.js HTTP + WebSocket server code and core game-logic modules (`src/`).
- Windows launcher **source code**, developer/test utilities and Node.js project configuration.
- MIT license for **original server code owned by SSS**, plus security and publication documentation.
- GitHub-generated `Source code (zip)` and `Source code (tar.gz)` archives of this tagged commit.

### Not included / 不包含

- Windows one-click installer `SSS-Qiyu-V15.2-Win64.exe`.
- Archived game frontend bundle `site.pak`, original images, sounds, music, and derived client content.
- Required map and game catalogs under `data/`, pending a separate rights review.
- Some client-side patches, five auxiliary build scripts, saved accounts, passwords, secrets and certificates.

**Do not expect this source snapshot to launch the complete game by itself.** A functioning game requires separately supplied frontend and gameplay data that you have the right to use.

### For developers / 开发者

Install a supported Node.js runtime and run `npm ci` in a checked-out source tree. Provide your own authorized game data and web assets before attempting full game startup.

Default project ports: game HTTP/WebSocket `14514`; admin `19810`. Keep the admin service private or behind HTTPS/access controls. Do not expose development commands in a public server.

### License and third-party rights / 许可

Copyright © 2026 SSS. Original server code authored and owned by SSS is MIT-licensed; the MIT license does **not** cover the original Qiyu client, artwork, music, extracted data, third-party dependencies, trademarks, or content the maintainer does not own.

This is an independent community project, not affiliated with the original game's rights holders.

### Windows EXE status

The separately prepared Windows binary has not been included because it bundles historical game assets whose redistribution permission has not been established. Its `CN=SSS` self-signature is not a trusted publisher certificate. A binary may be provided in a later release only after the assets have been cleared for redistribution.
