$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$dllPath = Join-Path $projectRoot "addin\VoteEnDirectAddin_v4.dll"
$csPath = Join-Path $projectRoot "addin\VoteEnDirectAddin.cs"
$cscPath = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

Write-Host "1. Compilation de la mise a jour du complement PowerPoint..." -ForegroundColor Cyan
if (Test-Path $dllPath) { Rename-Item $dllPath "$dllPath.bak_$([DateTime]::Now.Ticks)" -ErrorAction SilentlyContinue }
& $cscPath /target:library /out:$dllPath $csPath /r:Microsoft.CSharp.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /nologo | Out-Null

$clsid = "{8F4E3A21-9C1B-4D7E-A623-5E12B890C4D1}"
$progId = "VoteEnDirect.Addin"
$className = "VoteEnDirect.Connect"
$codeBaseUri = "file:///" + ($dllPath -replace "\\", "/")

Write-Host "2. Mise a jour de l'onglet 'Vote en Direct' dans le Ruban PowerPoint (HKCU)..." -ForegroundColor Cyan

# ProgID
New-Item -Path "HKCU:\Software\Classes\$progId" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\$progId" -Name "(Default)" -Value $className
New-Item -Path "HKCU:\Software\Classes\$progId\CLSID" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Classes\$progId\CLSID" -Name "(Default)" -Value $clsid

# CLSID (64-bit / AnyCPU)
$clsidBase = "HKCU:\Software\Classes\CLSID\$clsid"
New-Item -Path $clsidBase -Force | Out-Null
Set-ItemProperty -Path $clsidBase -Name "(Default)" -Value $className

$inproc = "$clsidBase\InprocServer32"
New-Item -Path $inproc -Force | Out-Null
Set-ItemProperty -Path $inproc -Name "(Default)" -Value "mscoree.dll"
Set-ItemProperty -Path $inproc -Name "ThreadingModel" -Value "Both"
Set-ItemProperty -Path $inproc -Name "Class" -Value $className
Set-ItemProperty -Path $inproc -Name "Assembly" -Value "VoteEnDirectAddin_v4, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null"
Set-ItemProperty -Path $inproc -Name "RuntimeVersion" -Value "v4.0.30319"
Set-ItemProperty -Path $inproc -Name "CodeBase" -Value $codeBaseUri

New-Item -Path "$clsidBase\ProgId" -Force | Out-Null
Set-ItemProperty -Path "$clsidBase\ProgId" -Name "(Default)" -Value $progId

New-Item -Path "$clsidBase\Implemented Categories\{62C8FE65-4EBB-45e7-B440-6E39B2CDBF29}" -Force | Out-Null

# Enregistrement dans PowerPoint Addins
$pptAddinKey = "HKCU:\Software\Microsoft\Office\PowerPoint\Addins\$progId"
New-Item -Path $pptAddinKey -Force | Out-Null
Set-ItemProperty -Path $pptAddinKey -Name "FriendlyName" -Value "Vote en Direct (OUI / NON / ABSTENTION)"
Set-ItemProperty -Path $pptAddinKey -Name "Description" -Value "Onglet Ruban PowerPoint pour voter les textes (OUI / NON / ABSTENTION)"
Set-ItemProperty -Path $pptAddinKey -Name "LoadBehavior" -Value 3 -Type DWord

Write-Host "3. Rechargement automatique dans Microsoft PowerPoint..." -ForegroundColor Cyan
try {
    $app = New-Object -ComObject PowerPoint.Application
    foreach ($comAddin in $app.COMAddIns) {
        if ($comAddin.ProgId -eq $progId) {
            $comAddin.Connect = $false
            $comAddin.Connect = $true
            Write-Host "   -> Boutons du Ruban 'Vote en Direct' actives !" -ForegroundColor Green
        }
    }
} catch {}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Green
Write-Host " PRET ! Cliquez maintenant sur 'QR Code Votants' ou" -ForegroundColor Green
Write-Host " 'Voter ce Slide (OUI / NON / ABSTENTION)' dans PowerPoint !" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
Write-Host ""
Set-Location $projectRoot
node scripts\start-app.cjs
