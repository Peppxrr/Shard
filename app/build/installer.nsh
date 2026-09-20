; Keep replacement silent. A deferred startup update gets a compact progress
; banner while NSIS replaces files, with no wizard or user interaction.
!macro ShardInstallLog MESSAGE
  Push $0
  CreateDirectory "$APPDATA\${PRODUCT_FILENAME}\logs"
  FileOpen $0 "$APPDATA\${PRODUCT_FILENAME}\logs\install.log" a
  FileSeek $0 0 END
  FileWrite $0 "${VERSION}: ${MESSAGE}$\r$\n"
  FileClose $0
  Pop $0
!macroend

!macro customInit
  ${if} ${isUpdated}
    !insertmacro ShardInstallLog "Silent update started"
    Push $0
    ReadEnvStr $0 "SHARD_UPDATE_ON_LAUNCH"
    ${if} $0 == "1"
      ; The built-in ONE_CLICK install section owns the progress banner and its
      ; lifetime. Creating it in .onInit (before the NSIS window exists) hangs.
      SetSilent normal
    ${endif}
    Pop $0
  ${endif}
!macroend

!macro customInstall
  ${if} ${isUpdated}
    !insertmacro ShardInstallLog "Application files replaced; launching updated app"
  ${endif}
!macroend
