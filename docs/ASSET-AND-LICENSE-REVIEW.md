# Asset, IP and privacy checklist / 素材及版权检查

Original server code authored and owned by SSS is released under the MIT License (see `../LICENSE`). The MIT grant does **not** include original game content, other parties' rights, or material not owned by SSS.

Before making code, binaries, or game data publicly downloadable:

- [ ] Verify authorization to redistribute the original game's `site.pak` (about 189 MiB) and its contents.
- [ ] Verify the origins and redistribution rights of images, audio, ALE assets and other files under `site/custom_assets/`.
- [ ] Review extracted client catalogs, map data and any reverse-engineered datasets separately from original server code.
- [ ] Preserve attributions, copyright notices and licenses for third-party dependencies.
- [ ] Grant an open-source license **only** over code you have the rights to license; avoid blanket claims over the original game.
- [ ] Ensure `var/state.json`, `admin-password.txt`, `.env`, keys, certificates and logs are absent from every commit and artifact.
- [ ] Turn off development/cheat endpoints (`QIYU_DEV=0`) when exposing the service.
- [ ] Restrict/administer HTTP port 19810 behind localhost or HTTPS with access control.
- [ ] Review the registration fallback: returning a code without sending mail **does not verify email ownership**.
- [ ] Remember that `CN=SSS` is a **self-signed** executable certificate, not a trusted Windows publisher signature.

Removing a file from a public repository later does not guarantee removal from clones or previously downloaded releases.
