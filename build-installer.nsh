!macro customInstall
  ${If} ${FileExists} "$INSTDIR\logo-build.ico"
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "DisplayIcon" "$INSTDIR\logo-build.ico"

    ${If} ${FileExists} "$newStartMenuLink"
      Delete "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$INSTDIR\logo-build.ico" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${EndIf}

    ${If} ${FileExists} "$newDesktopLink"
      Delete "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$INSTDIR\logo-build.ico" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${EndIf}
  ${EndIf}
!macroend
