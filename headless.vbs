' headless.vbs — Truly invisible launcher
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")

' Get the directory this script lives in
strDir = FSO.GetParentFolderName(WScript.ScriptFullName)

' Run restart.cjs using node, completely hidden (window style 0 = hidden, False = don't wait)
WshShell.Run "cmd.exe /c cd /d """ & strDir & """ && node restart.cjs", 0, False
