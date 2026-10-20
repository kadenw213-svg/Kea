; Registers Kea with Windows so it appears under "Open with" and in Settings > Default apps.
; electron-builder creates the Kea.<ext> ProgIDs; this adds the capability records Windows needs.

!macro customInstall
  ; Kea's earlier install ID put it in Programs\Slate Office (until 0.46). Once this copy is in place, that one goes
  ; with its uninstall entry: only when that folder really is Kea, and never the user's data (%APPDATA%\Kea).
  IfFileExists "$LOCALAPPDATA\Programs\Slate Office\Kea.exe" 0 old_done
    StrCmp "$INSTDIR" "$LOCALAPPDATA\Programs\Slate Office" old_done
    RMDir /r "$LOCALAPPDATA\Programs\Slate Office"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\bc898bdc-6a6b-520e-b4f4-79b3dd076ef4"
    DeleteRegKey HKCU "Software\bc898bdc-6a6b-520e-b4f4-79b3dd076ef4"
  old_done:
  ; The earlier name's update downloads and (empty) data folder.
  RMDir /r "$LOCALAPPDATA\slate-office-updater"
  RMDir "$APPDATA\Slate Office"
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe" "FriendlyAppName" "Kea"
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\shell\open\command" "" '"$INSTDIR\Kea.exe" "%1"'
  WriteRegStr HKCU "Software\Kea\Capabilities" "ApplicationName" "Kea"
  WriteRegStr HKCU "Software\Kea\Capabilities" "ApplicationDescription" "Offline office suite: PDFs, documents, spreadsheets and presentations."
  WriteRegStr HKCU "Software\RegisteredApplications" "Kea" "Software\Kea\Capabilities"
  WriteRegStr HKCU "Software\Classes\.pdf\OpenWithProgids" "Kea.pdf" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".pdf" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".pdf" "Kea.pdf"
  WriteRegStr HKCU "Software\Classes\.docx\OpenWithProgids" "Kea.docx" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".docx" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".docx" "Kea.docx"
  WriteRegStr HKCU "Software\Classes\.doc\OpenWithProgids" "Kea.doc" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".doc" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".doc" "Kea.doc"
  WriteRegStr HKCU "Software\Classes\.odt\OpenWithProgids" "Kea.odt" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".odt" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".odt" "Kea.odt"
  WriteRegStr HKCU "Software\Classes\.rtf\OpenWithProgids" "Kea.rtf" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".rtf" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".rtf" "Kea.rtf"
  WriteRegStr HKCU "Software\Classes\.html\OpenWithProgids" "Kea.html" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".html" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".html" "Kea.html"
  WriteRegStr HKCU "Software\Classes\.xlsx\OpenWithProgids" "Kea.xlsx" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".xlsx" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".xlsx" "Kea.xlsx"
  WriteRegStr HKCU "Software\Classes\.xls\OpenWithProgids" "Kea.xls" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".xls" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".xls" "Kea.xls"
  WriteRegStr HKCU "Software\Classes\.ods\OpenWithProgids" "Kea.ods" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".ods" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".ods" "Kea.ods"
  WriteRegStr HKCU "Software\Classes\.csv\OpenWithProgids" "Kea.csv" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".csv" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".csv" "Kea.csv"
  WriteRegStr HKCU "Software\Classes\.tsv\OpenWithProgids" "Kea.tsv" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".tsv" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".tsv" "Kea.tsv"
  WriteRegStr HKCU "Software\Classes\.pptx\OpenWithProgids" "Kea.pptx" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".pptx" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".pptx" "Kea.pptx"
  WriteRegStr HKCU "Software\Classes\.txt\OpenWithProgids" "Kea.txt" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".txt" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".txt" "Kea.txt"
  WriteRegStr HKCU "Software\Classes\.md\OpenWithProgids" "Kea.md" ""
  WriteRegStr HKCU "Software\Classes\Applications\Kea.exe\SupportedTypes" ".md" ""
  WriteRegStr HKCU "Software\Kea\Capabilities\FileAssociations" ".md" "Kea.md"
  ; Tell Explorer the associations changed.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\Kea.exe"
  DeleteRegKey HKCU "Software\Kea"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Kea"
  DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids" "Kea.pdf"
  DeleteRegValue HKCU "Software\Classes\.docx\OpenWithProgids" "Kea.docx"
  DeleteRegValue HKCU "Software\Classes\.doc\OpenWithProgids" "Kea.doc"
  DeleteRegValue HKCU "Software\Classes\.odt\OpenWithProgids" "Kea.odt"
  DeleteRegValue HKCU "Software\Classes\.rtf\OpenWithProgids" "Kea.rtf"
  DeleteRegValue HKCU "Software\Classes\.html\OpenWithProgids" "Kea.html"
  DeleteRegValue HKCU "Software\Classes\.xlsx\OpenWithProgids" "Kea.xlsx"
  DeleteRegValue HKCU "Software\Classes\.xls\OpenWithProgids" "Kea.xls"
  DeleteRegValue HKCU "Software\Classes\.ods\OpenWithProgids" "Kea.ods"
  DeleteRegValue HKCU "Software\Classes\.csv\OpenWithProgids" "Kea.csv"
  DeleteRegValue HKCU "Software\Classes\.tsv\OpenWithProgids" "Kea.tsv"
  DeleteRegValue HKCU "Software\Classes\.pptx\OpenWithProgids" "Kea.pptx"
  DeleteRegValue HKCU "Software\Classes\.txt\OpenWithProgids" "Kea.txt"
  DeleteRegValue HKCU "Software\Classes\.md\OpenWithProgids" "Kea.md"
!macroend
