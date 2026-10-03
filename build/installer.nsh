; BIM Twin - custom NSIS hook for electron-builder.
; After files are copied, auto-configures the Python engine (NumPy + Open3D)
; without user interaction. The script ships as an extraResource:
; $INSTDIR\resources\setup-python.ps1
; ASCII-only messages to avoid any encoding issues during compile/run.

!macro customInstall
  DetailPrint "BIM Twin: configuring the Python cleaning engine (NumPy + Open3D)..."
  DetailPrint "This may take a few minutes (downloading packages). Please wait..."
  ; Offline option: if a wheels folder is present nearby, install without internet.
  StrCpy $1 ""
  IfFileExists "$INSTDIR\resources\wheels\*.whl" 0 +2
    StrCpy $1 "-Wheels `"$INSTDIR\resources\wheels`""
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\setup-python.ps1" $1'
  Pop $0
  ${If} $0 == 0
    DetailPrint "BIM Twin: Python engine with Open3D configured - full cleaning quality."
  ${ElseIf} $0 == 2
    DetailPrint "BIM Twin: basic NumPy mode (Open3D can be installed later from the app)."
  ${Else}
    DetailPrint "BIM Twin: Python auto-setup did not finish (code $0). You can run it later from the app."
  ${EndIf}

  ; v1182: configure the Scan2BIM AI server venv (Cloud2BIM + pipes + cables + Mask3D)
  ; so the "Build BIM 1:1" button uses the auto-started server the moment the app opens.
  DetailPrint "BIM Twin: configuring the Scan2BIM AI server (CPU engine)..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\setup-ai-server.ps1"'
  Pop $3
  ${If} $3 == 0
    DetailPrint "BIM Twin: AI server ready (Cloud2BIM CPU engine)."
  ${ElseIf} $3 == 2
    DetailPrint "BIM Twin: AI server needs Python 3.10-3.12; using the built-in offline engine for now."
  ${Else}
    DetailPrint "BIM Twin: AI server setup did not finish (code $3). The app will use the built-in offline engine."
  ${EndIf}

  ; v1035: download + silent-install the CloudCompare editor (per-user, no admin).
  DetailPrint "BIM Twin: downloading and installing the CloudCompare editor (~100 MB). This can take several minutes..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\setup-cloudcompare.ps1" -Dest "$LOCALAPPDATA\BIMTwin\cloudcompare"'
  Pop $2
  ${If} $2 == 0
    DetailPrint "BIM Twin: CloudCompare editor installed."
  ${Else}
    DetailPrint "BIM Twin: CloudCompare auto-install did not finish (code $2). You can install it later from the app."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "BIM Twin: removing the isolated Python engine..."
  RMDir /r "$LOCALAPPDATA\BIMTwin"
!macroend
