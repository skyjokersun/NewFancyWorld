# NewFancyWorld / Qiyu V15.2 — draft Release notes

**Status:** Prepared for review; **not published**.

**Proposed tag:** `v15.2`

**Proposed Windows attachment:** `SSS-Qiyu-V15.2-Win64.exe`

### Features

- One-click Windows 10/11 x64 launcher with first-run installation folder selection.
- Automatically checks for Node.js and can install the required runtime to a private game directory.
- Runs the game locally on port **14514** and the GM admin on **19810**.
- Optional firewall permission step requiring user approval.
- Preserves local saves during normal restarts; back up saves before upgrades.
- Bundles the web game and associated server logic.

### Security and limitations

- Public network access requires appropriate firewall/router/tunnel configuration.
- The GM admin service uses HTTP; do not expose it directly without protection.
- Without configured outbound mail, the registration fallback does not prove email ownership.
- Binary signing is self-signed `CN=SSS`, **not** a CA-trusted publisher signature; SmartScreen warnings may remain.
- Windows end-user runtime has not been fully verified on a physical Windows machine.
- The executable includes historical game assets. **Do not publish until redistribution rights are confirmed.**

### Install

Download the EXE from the Release assets **once actually available**, run, select an installation folder, and open `http://127.0.0.1:14514/`. Admin interface: `http://127.0.0.1:19810/`. Obtain the locally generated admin password from the game's installation directory.

The EXE should be attached to Releases, **never committed to the repository**.
