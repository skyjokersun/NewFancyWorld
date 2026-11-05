// QiYu V15.2 single-file Windows launcher.
// Built as a small Windows PE with the original game ZIP appended as an overlay.
// The archive's contents are extracted to a per-user folder on first start.
package main

import (
	"archive/zip"
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	launcherVersion = "SSS-Qiyu-V15.2-network-dir-20261104-r2"
	nodeVersion     = "v22.16.0"
	nodeURL         = "https://nodejs.org/dist/v22.16.0/win-x64/node.exe"
	nodeURLBackup   = "https://nodejs.org/download/release/v22.16.0/win-x64/node.exe"
	nodeSHA256      = "c5ff4c736112dd483c750fd4149d30c8a116db1a49b8b3ec88be4b65e6c86c19"
	gameURL         = "http://127.0.0.1:14514/"
	adminURL        = "http://127.0.0.1:19810/"
	healthURL       = "http://127.0.0.1:14514/healthz"
)

func main() {
	fmt.Println("============================================")
	fmt.Println("          SSS 奇域 V15.2  Windows 一键启动")
	fmt.Println("============================================")
	if err := run(); err != nil {
		fmt.Println("\n[错误]", err)
		fmt.Println("游戏没有成功启动；请复制上面的错误信息以便排查。")
		if !flag("--no-pause") {
			fmt.Println("按 Enter 键退出...")
			fmt.Scanln()
		}
		os.Exit(1)
	}
}

func flag(s string) bool {
	for _, a := range os.Args[1:] {
		if a == s {
			return true
		}
	}
	return false
}

func run() error {
	// Keep loopback health checks and browser links even when server listens on all interfaces.
	if isHealthy() {
		if flag("--choose-dir") || argValue("--install-dir") != "" {
			return errors.New("本机已有奇域服务器运行。请先关闭旧游戏启动器，再更改安装目录。")
		}
		fmt.Println("本机 14514 端口已有奇域服务器，直接打开游戏页面。")
		if !flag("--no-browser") {
			openBrowser(gameURL)
		}
		return nil
	}
	dir, err := userHome()
	if err != nil {
		return fmt.Errorf("无法选择安装目录: %w", err)
	}
	gameDir := filepath.Join(dir, "game")
	fmt.Println("游戏安装目录:", dir)
	fmt.Println("存档目录:", filepath.Join(gameDir, "var"))
	if err := installGame(gameDir); err != nil {
		return err
	}
	// Persist only after extraction succeeds, so a canceled/bad selection isn't retained.
	if err := persistHome(dir); err != nil {
		fmt.Println("提示：无法保存安装位置，下次打开可能会再次询问：", err)
	}
	if runtime.GOOS == "windows" {
		offerFirewall()
	}
	node, err := findNode(dir)
	if err != nil {
		return err
	}
	fmt.Println("Node.js:", node)
	fmt.Println("本机游戏地址:", gameURL)
	fmt.Println("本机管理后台:", adminURL)
	printNetworkAddresses()
	fmt.Println("公网访问还需要路由器端口映射或其他有效入口；开放监听不代表自动获得公网地址。")
	fmt.Println("安全提示：后台 19810 是明文 HTTP，公网建议使用带 HTTPS 的反向代理。")
	fmt.Println("关闭本窗口将停止服务器，按 Ctrl+C 可退出。")
	for {
		err := launch(gameDir, node)
		var e *exec.ExitError
		if errors.As(err, &e) && e.ExitCode() == 75 {
			fmt.Println("后台正在重启服务器...")
			time.Sleep(800 * time.Millisecond)
			continue
		}
		return err
	}
}

// The explicit path takes precedence; a remembered folder is otherwise used on later runs.
func argValue(name string) string {
	for i, a := range os.Args[1:] {
		if strings.HasPrefix(a, name+"=") {
			return strings.TrimPrefix(a, name+"=")
		}
		if a == name && i+2 < len(os.Args) {
			return os.Args[i+2]
		}
	}
	return ""
}

type launcherSettings struct {
	InstallDir      string `json:"install_dir"`
	FirewallAsked   bool   `json:"firewall_asked"`
	FirewallEnabled bool   `json:"firewall_enabled"`
}

func settingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "SSS-Qiyu-V15.2", "launcher.json"), nil
}

func readSettings() launcherSettings {
	p, err := settingsPath()
	if err != nil {
		return launcherSettings{}
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return launcherSettings{}
	}
	var v launcherSettings
	if json.Unmarshal(data, &v) != nil {
		return launcherSettings{}
	}
	return v
}
func saveSettings(v launcherSettings) error {
	p, err := settingsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, append(b, '\n'), 0600)
}
func persistHome(dir string) error {
	v := readSettings()
	v.InstallDir = dir
	return saveSettings(v)
}

func userHome() (string, error) {
	if v := argValue("--install-dir"); v != "" {
		return filepath.Abs(os.ExpandEnv(v))
	}
	if v := os.Getenv("QIYU_LAUNCHER_HOME"); v != "" {
		return filepath.Abs(os.ExpandEnv(v))
	}
	previous := readSettings()
	if !flag("--choose-dir") && previous.InstallDir != "" {
		if info, err := os.Stat(previous.InstallDir); err == nil && info.IsDir() {
			return filepath.Abs(previous.InstallDir)
		}
		fmt.Println("之前的游戏目录不存在:", previous.InstallDir)
	}
	if runtime.GOOS == "windows" && !flag("--no-prompt") {
		fmt.Println("请选择游戏安装目录（可新建文件夹）；只在首次启动时询问。")
		if previous.InstallDir != "" {
			fmt.Println("之前的安装路径:", previous.InstallDir)
		}
		selected, err := chooseDirectory()
		if err != nil {
			return "", err
		}
		if selected == "" {
			return "", errors.New("已取消选择安装目录")
		}
		return filepath.Abs(selected)
	}
	if flag("--no-prompt") {
		return "", errors.New("使用 --no-prompt 时请设置 --install-dir 或 QIYU_LAUNCHER_HOME")
	}
	fmt.Println("请输入游戏安装目录；按 Enter 使用默认目录：")
	def, err := fallbackHome()
	if err != nil {
		return "", err
	}
	fmt.Println("默认:", def)
	r := bufio.NewReader(os.Stdin)
	line, err := r.ReadString('\n')
	if err != nil && err != io.EOF {
		return "", err
	}
	v := strings.Trim(strings.TrimSpace(line), "\"")
	if v == "" {
		return def, nil
	}
	return filepath.Abs(os.ExpandEnv(v))
}

func fallbackHome() (string, error) {
	if runtime.GOOS == "windows" {
		dir := os.Getenv("LOCALAPPDATA")
		if dir == "" {
			return "", errors.New("缺少 LOCALAPPDATA")
		}
		return filepath.Join(dir, "Qiyu-V15.2-Local"), nil
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "Qiyu-V15.2-Local"), nil
}

func printNetworkAddresses() {
	ifaces, err := net.Interfaces()
	if err != nil {
		return
	}
	shown := 0
	for _, device := range ifaces {
		if device.Flags&net.FlagUp == 0 || device.Flags&net.FlagLoopback != 0 {
			continue
		}
		ips, err := device.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range ips {
			ip, _, err := net.ParseCIDR(addr.String())
			if err != nil || ip.To4() == nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
				continue
			}
			fmt.Printf("局域网游戏: http://%s:14514/    管理: http://%s:19810/\n", ip, ip)
			shown++
			if shown >= 5 {
				return
			}
		}
	}
}

func offerFirewall() {
	v := readSettings()
	if !flag("--configure-firewall") && (v.FirewallAsked || flag("--no-prompt")) {
		return
	}
	fmt.Println("\n[网络端口放行] 服务将监听 0.0.0.0:14514 和 0.0.0.0:19810。")
	fmt.Println("是否添加 Windows 防火墙入站允许规则？需同意管理员 UAC。")
	fmt.Print("输入 Y 放行游戏+后台，输入 N 跳过（默认 N）：")
	// The user decides whether to expose both ports in Windows Firewall.
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	yes := strings.EqualFold(strings.TrimSpace(line), "y") || strings.EqualFold(strings.TrimSpace(line), "yes")
	v.FirewallAsked = true
	if yes {
		if err := configureFirewall(); err != nil {
			fmt.Println("未能自动配置 Windows 防火墙:", err)
			fmt.Println("可右键以管理员身份运行附带的防火墙规则批处理文件。")
		} else {
			fmt.Println("Windows 防火墙规则已添加：TCP 14514、19810（所有网络配置文件）。")
			v.FirewallEnabled = true
		}
	} else {
		fmt.Println("未自动修改系统防火墙。可用 --configure-firewall 重新配置。")
	}
	if err := saveSettings(v); err != nil {
		fmt.Println("配置保存失败:", err)
	}
}

func installGame(dir string) error {
	marker := filepath.Join(dir, ".launcher-version")
	data, err := os.ReadFile(marker)
	if err == nil && strings.TrimSpace(string(data)) == launcherVersion {
		if _, e := os.Stat(filepath.Join(dir, "src", "index.js")); e == nil {
			if _, e = os.Stat(filepath.Join(dir, "site.pak")); e == nil {
				fmt.Println("游戏文件已安装，跳过解压。")
				return nil
			}
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	zr, err := zip.OpenReader(exe)
	if err != nil {
		return fmt.Errorf("无法读取 EXE 中的游戏数据: %w", err)
	}
	defer zr.Close()
	fmt.Printf("首次运行：正在释放游戏数据（%d 个文件）...\n", len(zr.File))
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	total, count := 0, 0
	for _, f := range zr.File {
		// The original archive puts everything under 'qiyu-server/'.
		name := strings.TrimPrefix(strings.ReplaceAll(f.Name, "\\", "/"), "qiyu-server/")
		if name == "" || strings.HasSuffix(name, "/") {
			continue
		}
		cleaned := filepath.Clean(filepath.FromSlash(name))
		if filepath.IsAbs(cleaned) || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
			return fmt.Errorf("压缩包存在不安全的路径: %s", f.Name)
		}
		if f.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("不支持符号链接: %s", f.Name)
		}
		dst := filepath.Join(dir, cleaned)
		// Never overwrite user saves, uploaded art or generated admin passwords.
		if cleaned == "var" || strings.HasPrefix(cleaned, "var"+string(filepath.Separator)) || cleaned == "admin-password.txt" {
			if _, err := os.Stat(dst); err == nil {
				continue
			}
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			return err
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		tmp := dst + ".qiyu-install-tmp"
		out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0644)
		if err != nil {
			in.Close()
			return err
		}
		n, cpErr := io.Copy(out, in)
		closeErr := out.Close()
		inErr := in.Close()
		if cpErr != nil || closeErr != nil || inErr != nil || n != int64(f.UncompressedSize64) {
			os.Remove(tmp)
			return fmt.Errorf("解压游戏文件失败 %s: %v, %v, %v", name, cpErr, closeErr, inErr)
		}
		// os.Rename cannot replace existing files on some Windows versions.
		if _, err := os.Stat(dst); err == nil {
			if err = os.Remove(dst); err != nil {
				return err
			}
		}
		if err := os.Rename(tmp, dst); err != nil {
			return err
		}
		count++
		total += int(n)
	}
	if err := os.WriteFile(marker, []byte(launcherVersion+"\n"), 0644); err != nil {
		return err
	}
	fmt.Printf("释放完成：%d 个文件，约 %.1f MB。\n", count, float64(total)/1024/1024)
	return nil
}

func nodeIsUsable(node string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, node, "--version").Output()
	if err != nil {
		return false
	}
	v := strings.TrimSpace(string(out))
	v = strings.TrimPrefix(v, "v")
	parts := strings.SplitN(v, ".", 2)
	major, err := strconv.Atoi(parts[0])
	return err == nil && major >= 18
}

func shaOK(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == nodeSHA256
}

func findNode(dir string) (string, error) {
	// Use existing Node.js when its version satisfies the game requirements.
	if path, err := exec.LookPath("node"); err == nil && nodeIsUsable(path) {
		fmt.Println("检测到电脑已安装 Node.js（18 或更高），无需下载安装。")
		return path, nil
	}
	// Avoid any system-wide installation or admin prompts: use a private portable binary.
	runtimeDir := filepath.Join(dir, "runtime")
	local := filepath.Join(runtimeDir, "node.exe")
	if runtime.GOOS != "windows" { // For developers running the Linux smoke build only.
		if path, err := exec.LookPath("node"); err == nil {
			return path, nil
		}
		return "", errors.New("缺少 Node.js；Windows EXE 会自动安装便携式运行时")
	}
	if shaOK(local) && nodeIsUsable(local) {
		fmt.Println("使用之前下载的 Node.js 便携运行时。")
		return local, nil
	}
	if err := os.MkdirAll(runtimeDir, 0755); err != nil {
		return "", err
	}
	fmt.Println("未找到 Node.js >=18，自动下载官方 Node.js", nodeVersion, "(Windows x64)。")
	fmt.Println("只下载到游戏专用目录，无需管理员权限。首次下载约 85 MB。")
	for _, url := range []string{nodeURL, nodeURLBackup} {
		if err := downloadNode(url, local); err != nil {
			fmt.Println("下载线路失败:", err)
			continue
		}
		if nodeIsUsable(local) {
			return local, nil
		}
		return "", errors.New("下载的 Node.js 无法在本电脑启动；请确认系统是 64 位 Windows 10/11")
	}
	return "", fmt.Errorf("Node.js 官方下载失败（检查网络或代理）。也可以自行安装 Node.js 18+ 后重试。官方网址：%s", nodeURL)
}

func downloadNode(url, destination string) error {
	cli := &http.Client{Timeout: 15 * time.Minute}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Qiyu-V15.2-Local-Launcher/1.0")
	resp, err := cli.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	tmp := destination + ".download"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	h := sha256.New()
	w := &progress{total: resp.ContentLength, last: -1}
	_, err = io.Copy(io.MultiWriter(f, h, w), resp.Body)
	closeErr := f.Close()
	fmt.Println()
	if err != nil || closeErr != nil {
		os.Remove(tmp)
		return fmt.Errorf("下载写入失败: %v %v", err, closeErr)
	}
	digest := hex.EncodeToString(h.Sum(nil))
	if digest != nodeSHA256 {
		os.Remove(tmp)
		return fmt.Errorf("Node.js 校验失败（SHA-256不匹配）：%s", digest)
	}
	if _, err := os.Stat(destination); err == nil {
		os.Remove(destination)
	}
	if err := os.Rename(tmp, destination); err != nil {
		return err
	}
	fmt.Println("Node.js 下载完成，官方 SHA-256 校验通过。")
	return nil
}

type progress struct {
	total int64
	done  int64
	last  int
}

func (p *progress) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if p.total > 0 {
		x := int(100 * p.done / p.total)
		if x/5 != p.last/5 || p.last < 0 {
			fmt.Printf("\r  下载进度: %d%% (%.1f / %.1f MB)", x, float64(p.done)/1048576, float64(p.total)/1048576)
			p.last = x
		}
	} else if p.done/10485760 > int64(p.last) {
		fmt.Printf("\r已下载: %.1f MB", float64(p.done)/1048576)
		p.last = int(p.done / 10485760)
	}
	return len(b), nil
}

func isHealthy() bool {
	client := http.Client{Timeout: 650 * time.Millisecond}
	resp, err := client.Get(healthURL)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return false
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 128))
	return strings.Contains(string(b), `"ok":true`)
}

func launch(gameDir, node string) error {
	logDir := filepath.Join(gameDir, "var")
	if err := os.MkdirAll(logDir, 0755); err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(logDir, "launcher.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer log.Close()
	fmt.Println("正在启动游戏服务器（接受局域网和公网入口连接）...")
	cmd := exec.Command(node, filepath.Join(gameDir, "src", "index.js"))
	cmd.Dir = gameDir
	cmd.Env = append(os.Environ(),
		"QIYU_HOST=0.0.0.0", "QIYU_ADMIN_HOST=0.0.0.0",
		"QIYU_DEV=0", "QIYU_DEV_EMAIL_CODE=", "QIYU_ALLOW_REGISTER_WITHOUT_MAIL=1",
		"QIYU_PORT=14514", "QIYU_ADMIN_PORT=19810",
		"QIYU_LEGACY_PAGE_PORT=0", "QIYU_LEGACY_WS_PORT=0",
	)
	cmd.Stdout = io.MultiWriter(os.Stdout, log)
	cmd.Stderr = io.MultiWriter(os.Stderr, log)
	cmd.Stdin = os.Stdin
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 Node.js 失败: %w", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	ready := false
	for i := 0; i < 120; i++ {
		select {
		case e := <-done:
			if e == nil {
				return errors.New("服务器在建立连接前就退出了")
			}
			return fmt.Errorf("服务器启动中止: %w", e)
		default:
		}
		if isHealthy() {
			ready = true
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if !ready {
		_ = cmd.Process.Kill()
		<-done
		return errors.New("服务器 60 秒内没有就绪，请检查端口 14514/19810 是否已被占用；查看 var/launcher.log")
	}
	fmt.Println("\n============================================")
	fmt.Println("游戏服务器已启动，正在打开浏览器：", gameURL)
	fmt.Println("管理后台：", adminURL)
	fmt.Println("游戏存档：", filepath.Join(gameDir, "var", "state.json"))
	fmt.Println("============================================")
	if !flag("--no-browser") {
		openBrowser(gameURL)
	}
	err = <-done
	if err != nil {
		fmt.Println("游戏服务器退出:", err)
	} else {
		fmt.Println("游戏已退出。")
	}
	return err
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	} else if runtime.GOOS == "darwin" {
		cmd = exec.Command("open", url)
	} else {
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		fmt.Println("无法自动打开浏览器，可手动访问：", url)
	}
}
