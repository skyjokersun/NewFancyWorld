# Publish V15.2 source to this repository

The prepared source ZIP is **not** meant to be committed as one giant file. Extract `Qiyu-V15.2-GitHub-Source.zip` and upload the **contents** of its `qiyu-server/` folder.

**Before publishing:** Follow [asset and rights review](ASSET-AND-LICENSE-REVIEW.md). It includes client-derived data and assets whose redistribution rights have not been established. Exclude anything you cannot legally redistribute.

## Use GitHub Desktop

1. Clone `https://github.com/skyjokersun/NewFancyWorld.git`.
2. Copy **reviewed** files from the prepared `qiyu-server/` directory into the clone, without overwriting `LICENSE`, `README.md`, `.gitignore` or `docs/` unless you intentionally reconciled them.
3. Use the **Changes** view to ensure no `site.pak`, `node_modules`, `.env`, `var/state.json`, `admin-password.txt`, keys, or binaries appear.
4. Commit, then **Push origin**.

## Command line alternative

```powershell
git clone https://github.com/skyjokersun/NewFancyWorld.git
cd NewFancyWorld
# Copy only reviewed source files into this directory.
git status
git add .
git diff --cached --stat
git commit -m "Add reviewed Qiyu V15.2 sources"
git push origin main
```

### Windows EXE

After confirming asset rights, create GitHub Release tag `v15.2` with target `main`, copy notes from [RELEASE-v15.2.md](RELEASE-v15.2.md), and attach `SSS-Qiyu-V15.2-Win64.exe` plus `SHA256SUMS.txt`. Do not commit the binary to Git.

**Important:** A public GitHub repo is not an always-on game server.
