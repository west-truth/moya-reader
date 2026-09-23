!macro NSIS_HOOK_PREINSTALL
  InitPluginsDir
  File /oname=$PLUGINSDIR\vc_redist.x64.exe "__MOYA_VC_REDIST__"
  DetailPrint "Preparing Microsoft Visual C++ Runtime..."
  ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $0
  ${If} $0 == 3010
    SetRebootFlag true
  ${ElseIf} $0 != 0
  ${AndIf} $0 != 1638
    MessageBox MB_ICONSTOP "Microsoft Visual C++ Runtime installation failed ($0)."
    Abort
  ${EndIf}
!macroend
