//go:build windows

package main

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

type browseInfo struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName uintptr
	lpszTitle      uintptr
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

func chooseDirectory() (string, error) {
	// Legacy Shell folder picker: works on Windows without PowerShell, .NET, or external DLLs.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ole := syscall.NewLazyDLL("ole32.dll")
	coinit := ole.NewProc("CoInitializeEx")
	cofree := ole.NewProc("CoTaskMemFree")
	uninit := ole.NewProc("CoUninitialize")
	r, _, _ := coinit.Call(0, 2) // COINIT_APARTMENTTHREADED
	if int32(r) == 0 || int32(r) == 1 {
		defer uninit.Call()
	}
	shell := syscall.NewLazyDLL("shell32.dll")
	browse := shell.NewProc("SHBrowseForFolderW")
	getPath := shell.NewProc("SHGetPathFromIDListW")
	title, _ := syscall.UTF16PtrFromString("SSS 奇域 V15.2 — 请选择游戏安装目录（可新建文件夹）")
	name := make([]uint16, 260)
	info := browseInfo{pszDisplayName: uintptr(unsafe.Pointer(&name[0])), lpszTitle: uintptr(unsafe.Pointer(title)), ulFlags: 0x0001 | 0x0040 | 0x0010}
	// BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE | BIF_EDITBOX
	pidl, _, _ := browse.Call(uintptr(unsafe.Pointer(&info)))
	if pidl == 0 {
		return "", errors.New("用户取消安装目录选择")
	}
	defer cofree.Call(pidl)
	path := make([]uint16, 32768)
	ok, _, _ := getPath.Call(pidl, uintptr(unsafe.Pointer(&path[0])))
	if ok == 0 {
		return "", errors.New("无法读取所选目录（请选择本地磁盘文件夹）")
	}
	return syscall.UTF16ToString(path), nil
}

func encodePS(s string) string {
	u := utf16.Encode([]rune(s))
	b := make([]byte, len(u)*2)
	for i, x := range u {
		binary.LittleEndian.PutUint16(b[2*i:], x)
	}
	return base64.StdEncoding.EncodeToString(b)
}
func configureFirewall() error {
	// One visible UAC prompt. No silent privilege escalation or router port changes.
	script := `$ErrorActionPreference = 'Stop';` +
		`$list = @(@('SSS-Qiyu-Game-14514',14514),@('SSS-Qiyu-Admin-19810',19810));` +
		`foreach($r in $list) {` +
		`Get-NetFirewallRule -DisplayName $r[0] -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop;` +
		`New-NetFirewallRule -DisplayName $r[0] -Direction Inbound -Action Allow -Protocol TCP -LocalPort $r[1] -Profile Any | Out-Null` +
		`}`
	inner := encodePS(script)
	command := fmt.Sprintf(`$p=Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','%s');exit $p.ExitCode`, inner)
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePS(command))
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("UAC 被拒绝或命令失败 (%v): %s", err, string(out))
	}
	return nil
}
