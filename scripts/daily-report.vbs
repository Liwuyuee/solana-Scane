' 静默运行 daily-report.js（不弹窗）
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\MACHENIKE\Desktop\solana-monitor"
shell.Run "node scripts/daily-report.js >> daily-report.log 2>&1", 0, False
Set shell = Nothing
