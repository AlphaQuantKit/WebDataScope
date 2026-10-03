@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
(
echo WebDataScope 一键更新器
echo 更新完成前，请保持此窗口打开。
if not exist "%~dp0scripts\update-extension.ps1" (
    echo 缺少 scripts\update-extension.ps1，请先完整解压插件安装包。
    echo 按任意键关闭窗口……
    pause >nul
    exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-extension.ps1" -InstallDirectory "%~dp0." %*
if errorlevel 1 (
    echo 更新未完成，请查看上方的错误提示。
    echo 按任意键关闭窗口……
    pause >nul
    exit /b 1
)
echo 按任意键关闭窗口……
pause >nul
exit /b 0
)
