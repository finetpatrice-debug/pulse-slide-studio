Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "c:\APPLICATION SONDAGE"
sh.Run """c:\APPLICATION SONDAGE\node_modules\electron\dist\electron.exe"" . ""http://localhost:5173/?pptAction=trigger""", 1, False
