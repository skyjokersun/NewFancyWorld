# SSS Windows 启动器源码

此目录保留此前创建的 EXE 启动器 Go 源文件，用于审查启动行为和本地构建。**不包含私钥，也不包含游戏前端 `site.pak` 或附加在 EXE 后面的 170+ MiB 游戏 payload。**

该构建工具针对的是 V15.2 专用安装器，使用 Windows/amd64 与 Go 1.23 或更新版本。

完整重建流程：

1. 在有合法分发权的前提下，从你自己的 V15.2 完整目录生成带 `qiyu-server/` 文件夹前缀的 `gamepayload.zip`；其中应含 `site.pak`、`src/`、`data/`、`site/`、已安装运行时依赖等，且 `src/game/accounts.js` 需包含和发行版一致的注册兼容补丁。
2. 在本目录执行 `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o launcher-stub.exe .`（PowerShell 设置环境变量的语法不同，见下面）。
3. 将 ZIP 原始字节**追加**到 `launcher-stub.exe` 末尾，生成 Windows 启动器；该程序使用 `zip.OpenReader(exe)` 读取追加数据。
4. 如果你有自己合法取得的代码签名证书，使用签名工具对最终生成的 EXE 进行签名；不应将私钥推送 GitHub。

PowerShell 构建 stub（需要已安装 Go）：

```powershell
$env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
go build -o launcher-stub.exe .
```

**注意**：没有前端资源 `site.pak` 时，无法从这份 GitHub 源码独立重建完整可玩 EXE。仓库也不提供可以自动获取原版游戏客户端资源的下载脚本。

发布的 `SSS-Qiyu-V15.2-Win64.exe` 是**自签名历史构建物**。在没有同一签名私钥和完全相同的构建环境的情况下，重新构建的 EXE 不可能具有相同的签名或 SHA-256，这是正常现象。
