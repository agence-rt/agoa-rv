; Personnalisation de l'assistant d'installation AGOA PV.
; Page d'accueil qui annonce les étapes, dont le choix du dossier d'installation.
; (Les mises à jour automatiques, lancées avec --updated, restent silencieuses.)
!macro customWelcomePage
  !insertmacro skipPageIfUpdated
  !define MUI_WELCOMEPAGE_TITLE "Installation d'AGOA PV"
  !define MUI_WELCOMEPAGE_TEXT "Cet assistant va installer AGOA PV, suivi de chantier et procès-verbaux de réunion.$\r$\n$\r$\nÉtapes :$\r$\n  1. Pour qui installer (vous seul ou tous les utilisateurs du poste)$\r$\n  2. Choix du dossier d'installation$\r$\n  3. Installation$\r$\n$\r$\nVos données et vos fichiers .pv ne sont pas modifiés.$\r$\n$\r$\nCliquez sur Suivant pour continuer."
  !insertmacro MUI_PAGE_WELCOME
!macroend
