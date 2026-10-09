; Personnalisation de l'assistant d'installation AGOA PV.
; (Les mises à jour automatiques, lancées avec --updated, restent silencieuses.)

; Page d'accueil qui annonce les étapes, dont le choix du dossier d'installation.
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Installation d'AGOA PV"
  !define MUI_WELCOMEPAGE_TEXT "Cet assistant va installer AGOA PV, suivi de chantier et procès-verbaux de réunion.$\r$\n$\r$\nÉtapes :$\r$\n  1. Pour qui installer (vous seul ou tous les utilisateurs du poste)$\r$\n  2. Choix du dossier d'installation$\r$\n  3. Installation$\r$\n$\r$\nVos données et vos fichiers .pv ne sont pas modifiés.$\r$\n$\r$\nCliquez sur Suivant pour continuer."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Après le choix du dossier : on vérifie qu'on peut y écrire AVANT de lancer l'installation.
; Ex. « Pour moi seulement » + un dossier dans C:\Program Files => pas de droits d'écriture.
; La page ne s'affiche que si le dossier est protégé ; « Précédent » ramène au choix du dossier.
!macro customPageAfterChangeDir
  Var agoaDirLabel
  Var agoaShortcutBox
  Var agoaShortcutState
  Page custom agoaDirCheckPre agoaDirCheckLeave
  Page custom agoaShortcutPre agoaShortcutLeave
  ; $0 = "1" si le dossier final ($INSTDIR\<appli>) est accessible en écriture.
  Function agoaDirWritable
    Push $1
    Push $2
    StrCpy $2 $INSTDIR
    ${StrContains} $1 "${APP_FILENAME}" $2
    ${If} $1 == ""
      StrCpy $2 "$2\${APP_FILENAME}"
    ${EndIf}
    ClearErrors
    CreateDirectory $2
    StrCpy $0 "0"
    ClearErrors
    FileOpen $1 "$2\.agoa-pv-test" w
    ${IfNot} ${Errors}
    ${AndIf} $1 != ""
      FileClose $1
      Delete "$2\.agoa-pv-test"
      StrCpy $0 "1"
    ${EndIf}
    Pop $2
    Pop $1
  FunctionEnd

  Function agoaDirCheckPre
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    Call agoaDirWritable
    ${If} $0 == "1"
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "Dossier protégé" "AGOA PV ne peut pas écrire dans le dossier choisi."
    nsDialogs::Create 1018
    Pop $1
    ${NSD_CreateLabel} 0u 0u 300u 120u "Le dossier suivant est protégé par Windows :$\r$\n$\r$\n$INSTDIR$\r$\n$\r$\nVous avez choisi d'installer pour vous seul, sans droits administrateur. Cliquez sur « Précédent » puis :$\r$\n$\r$\n  • choisissez un autre dossier (par exemple le dossier proposé par défaut, dans votre profil),$\r$\n  • ou revenez à l'étape précédente et choisissez « Pour tous les utilisateurs » (Windows demandera l'autorisation administrateur)."
    Pop $agoaDirLabel
    GetDlgItem $1 $HWNDPARENT 1
    EnableWindow $1 0
    nsDialogs::Show
  FunctionEnd

  Function agoaDirCheckLeave
    Call agoaDirWritable
    ${If} $0 != "1"
      Abort
    ${EndIf}
  FunctionEnd

  ; Proposition d'un raccourci sur le Bureau (coché par défaut ; ignorée lors d'une mise à jour automatique).
  Function agoaShortcutPre
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "Raccourci" "Souhaitez-vous un raccourci pour lancer AGOA PV ?"
    nsDialogs::Create 1018
    Pop $1
    ${NSD_CreateLabel} 0u 0u 300u 24u "AGOA PV sera accessible depuis le menu Démarrer. Vous pouvez aussi l'ajouter sur le Bureau."
    Pop $1
    ${NSD_CreateCheckbox} 0u 34u 300u 12u "Créer un raccourci sur le Bureau"
    Pop $agoaShortcutBox
    ${If} $agoaShortcutState == ""
      StrCpy $agoaShortcutState ${BST_CHECKED}
    ${EndIf}
    ${NSD_SetState} $agoaShortcutBox $agoaShortcutState
    nsDialogs::Show
  FunctionEnd

  Function agoaShortcutLeave
    ${NSD_GetState} $agoaShortcutBox $agoaShortcutState
  FunctionEnd
!macroend

!macro customInstall
  ${IfNot} ${isUpdated}
    ${If} $agoaShortcutState == ${BST_CHECKED}
      CreateShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
    ${EndIf}
  ${EndIf}
!macroend
