//go:build !windows

package main

import "errors"

func chooseDirectory() (string, error) { return "", errors.New("文件夹选择器仅支持 Windows") }
func configureFirewall() error         { return errors.New("防火墙配置仅支持 Windows") }
