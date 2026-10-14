; Dialect's installer hooks (tauri.conf.json, bundle.windows.nsis.installerHooks), included into Tauri's installer.nsi.
;
; The installer puts the dialect command (the standalone CLI, cli\dialect.exe: the app's own dialect.exe is beside it)
; in the install folder, and asks whether to put that folder on the user's PATH, so a new terminal can run `dialect`.
; Yes is the default, also for a silent install (/S). It's the user's PATH (HKCU\Environment), so no admin is needed;
; the uninstaller takes the folder off it again. Entries written with %VARIABLES% stay so: the value is read and
; written unexpanded. Windows PowerShell does the edit (part of every Windows 10 and 11), with the folder passed in an
; environment variable, so no quoting of the path can go wrong.

; HWND_BROADCAST, WM_SETTINGCHANGE: open windows (Explorer, so new terminals) take the new PATH.
!define DIALECT_HWND_BROADCAST 0xFFFF
!define DIALECT_WM_SETTINGCHANGE 0x001A

; ADD 1 puts $INSTDIR\cli on the user's PATH once (at the end); ADD 0 takes it off.
!macro DIALECT_EDIT_PATH ADD
  System::Call 'Kernel32::SetEnvironmentVariable(t "DIALECT_CLI_DIR", t "$INSTDIR\cli")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "DIALECT_PATH_ADD", t "${ADD}")i'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$key = 'HKCU:\Environment'; $$dir = $$env:DIALECT_CLI_DIR; $$path = (Get-Item $$key).GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$parts = @($$path -split ';' | Where-Object { $$_ -and $$_ -ne $$dir }); if ($$env:DIALECT_PATH_ADD -eq '1') { $$parts += $$dir }; if ($$parts.Count) { Set-ItemProperty -Path $$key -Name Path -Value ($$parts -join ';') -Type ExpandString } else { Remove-ItemProperty -Path $$key -Name Path -ErrorAction SilentlyContinue }"`
  Pop $0
  SendMessage ${DIALECT_HWND_BROADCAST} ${DIALECT_WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  MessageBox MB_YESNO|MB_ICONQUESTION "Add the dialect command to your PATH, so a terminal can run it?$\n$\n(It's installed in $INSTDIR\cli.)" /SD IDYES IDNO dialect_skip_path
  !insertmacro DIALECT_EDIT_PATH 1
  dialect_skip_path:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro DIALECT_EDIT_PATH 0
!macroend
