[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "SilentlyContinue"

# Strings accents & symboles en Unicode pur (100% compatible Windows PowerShell 5.1 sans BOM)
$SYM_PLAY  = [string][char]0x25B6
$SYM_STOP  = [string][char]0x23F9
$SYM_DASH  = [string][char]0x2014
$SYM_BUL   = [string][char]0x2022
$E_ACUTE   = [string][char]0x00E9
$E_CAP     = [string][char]0x00C9
$A_GRAVE   = [string][char]0x00E0
$O_CIRC    = [string][char]0x00F4
$O_CAP_CIR = [string][char]0x00D4
$C_CEDIL   = [string][char]0x00E7
$N_ORD     = [string][char]0x00B0

$TXT_LANCER_VOTE = "$SYM_PLAY LANCER LE VOTE SUR CE SLIDE"
$TXT_RESULTAT_HDR = "R" + $E_CAP + "SULTAT DU VOTE " + $SYM_DASH + " Diapositive"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PptMouseHelper {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);
}
"@ -ErrorAction SilentlyContinue

$projectRoot = Split-Path -Parent $PSScriptRoot
$slidesOutDir = Join-Path $projectRoot "public\slides"
if (-not (Test-Path $slidesOutDir)) {
  New-Item -ItemType Directory -Path $slidesOutDir -Force | Out-Null
}

$script:cachedPptApp = $null
$script:lastExportedPres = ""
$script:lastExportedCount = 0
$script:lastExportedSlide = -1
$script:lastClickTime = [DateTime]::MinValue
$script:lastBtnStateKey = ""

function Convert-ToOleRgb([int]$r, [int]$g, [int]$b) {
  return [int]($r + ($g * 256) + ($b * 65536))
}

function Get-RunningPptApp {
  if ($null -ne $script:cachedPptApp) {
    try {
      $cnt = [int]$script:cachedPptApp.Presentations.Count
      if ($cnt -gt 0) {
        return $script:cachedPptApp
      }
    } catch {
      $script:cachedPptApp = $null
    }
  }

  $procs = @(Get-Process POWERPNT -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) {
    $script:cachedPptApp = $null
    return $null
  }

  try {
    $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")
    if ($null -ne $app -and [int]$app.Presentations.Count -gt 0) {
      $script:cachedPptApp = $app
      return $app
    }
  } catch {}

  return $null
}

function Test-IsVotingSlide($slide) {
  try {
    foreach ($shape in @($slide.Shapes)) {
      if ([string]$shape.Name -like "VoteEnDirect_*") {
        return $true
      }
      if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
        $txt = [string]$shape.TextFrame.TextRange.Text
        if ($txt -match "(?i)(Proposition|Votes\s*:|ClassPoint|Vote en Direct|LANCER LE VOTE|ABST)") {
          return $true
        }
      }
    }
  } catch {}
  return $false
}

function Ensure-VoteElementsOnSlide($pres, $slide, [bool]$forceOnThisSlide = $false) {
  $modified = $false
  try {
    $isVoteSlide = $forceOnThisSlide -or (Test-IsVotingSlide $slide)
    if (-not $isVoteSlide) {
      return $false
    }

    $slideW = [double]$pres.PageSetup.SlideWidth
    $slideH = [double]$pres.PageSetup.SlideHeight
    if ($slideW -le 0) { $slideW = 960 }
    if ($slideH -le 0) { $slideH = 540 }

    $qrFile = Join-Path $slidesOutDir "qr-session.png"
    $hasQrFile = Test-Path $qrFile

    $labelShape = $null
    $alreadyHasQr = $false
    $oldLeftQrPic = $null
    $existingBtn = $null

    foreach ($shape in @($slide.Shapes)) {
      try {
        $sName = [string]$shape.Name
        if ($sName -eq "VoteEnDirect_QR") {
          $alreadyHasQr = $true
        }
        elseif ($sName -like "VoteEnDirect_BtnVote*") {
          $existingBtn = $shape
        }
        elseif ([int]$shape.Type -eq 13 -and [double]$shape.Left -lt ($slideW * 0.36) -and [double]$shape.Top -gt ($slideH * 0.20) -and [double]$shape.Top -lt ($slideH * 0.72) -and [double]$shape.Width -gt 70) {
          $diff = [Math]::Abs([double]$shape.Width - [double]$shape.Height)
          if ($diff -lt 70) {
            $oldLeftQrPic = $shape
          }
        }

        if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
          $txt = [string]$shape.TextFrame.TextRange.Text
          if ($txt -match "(?i)ClassPoint") {
            $shape.TextFrame.TextRange.Text = ($txt -replace "(?i)ClassPoint", "Vote en Direct")
            $labelShape = $shape
            $modified = $true
          }
          elseif ($txt -match "(?i)^Vote en Direct") {
            $labelShape = $shape
          }
        }
      } catch {}
    }

    # 1. Image du QR Code directement dans le slide (a gauche, sous "Vote en Direct")
    if ($hasQrFile -and -not $alreadyHasQr) {
      $qrSize = [Math]::Round($slideH * 0.40)
      $qrLeft = [Math]::Round($slideW * 0.085)
      $qrTop = [Math]::Round($slideH * 0.31)

      if ($null -ne $oldLeftQrPic) {
        $qrLeft = [double]$oldLeftQrPic.Left
        $qrTop = [double]$oldLeftQrPic.Top
        $qrSize = [double]$oldLeftQrPic.Width
        try { $oldLeftQrPic.Delete() } catch {}
      }
      elseif ($null -ne $labelShape) {
        $lLeft = [double]$labelShape.Left
        $lTop = [double]$labelShape.Top
        $lW = [double]$labelShape.Width
        $lH = [double]$labelShape.Height
        $qrLeft = [Math]::Max(30, [Math]::Round(($lLeft + ($lW / 2.0)) - ($qrSize / 2.0)))
        $qrTop = [Math]::Round($lTop + $lH + 6)
      }

      try {
        $newPic = $slide.Shapes.AddPicture($qrFile, 0, -1, $qrLeft, $qrTop, $qrSize, $qrSize)
        $newPic.Name = "VoteEnDirect_QR"
        $modified = $true
      } catch {}
    }

    # 2. Bouton "LANCER LE VOTE SUR CE SLIDE" directement dans le slide (a droite, sous A OUI | B NON | C ABST)
    $sId = [int]$slide.SlideID
    $sIdx = [int]$slide.SlideIndex
    $expectedSub = "$sId,$sIdx,VoteEnDirect"

    if ($null -eq $existingBtn) {
      $btnW = [Math]::Round($slideW * 0.40)
      $btnH = [Math]::Round($slideH * 0.115)
      $btnLeft = [Math]::Round($slideW * 0.46)
      $btnTop = [Math]::Round($slideH * 0.58)

      try {
        $btn = $slide.Shapes.AddShape(5, $btnLeft, $btnTop, $btnW, $btnH)
        $btn.Name = "VoteEnDirect_BtnVote"
        $btn.Fill.ForeColor.RGB = (Convert-ToOleRgb 16 185 129)
        $btn.Line.ForeColor.RGB = (Convert-ToOleRgb 4 120 87)
        $btn.Line.Weight = 2.25
        $btn.TextFrame.TextRange.Text = $TXT_LANCER_VOTE
        $btn.TextFrame.TextRange.Font.Name = "Calibri"
        $btn.TextFrame.TextRange.Font.Size = 16
        $btn.TextFrame.TextRange.Font.Bold = -1
        $btn.TextFrame.TextRange.Font.Color.RGB = (Convert-ToOleRgb 255 255 255)
        $btn.TextFrame.TextRange.ParagraphFormat.Alignment = 2

        $btn.ActionSettings.Item(1).Action = 7
        $btn.ActionSettings.Item(1).Hyperlink.SubAddress = $expectedSub
        $modified = $true
      } catch {}
    } else {
      try {
        if ([string]$existingBtn.ActionSettings.Item(1).Hyperlink.SubAddress -ne $expectedSub) {
          $existingBtn.ActionSettings.Item(1).Action = 7
          $existingBtn.ActionSettings.Item(1).Hyperlink.SubAddress = $expectedSub
        }
      } catch {}
    }
  } catch {}
  return $modified
}

function Update-AllVotingSlidesInPresentation($pres, [int]$currentSlideIndex = 1, [bool]$forceOnCurrent = $false) {
  try {
    $total = [int]$pres.Slides.Count
    for ($i = 1; $i -le $total; $i++) {
      $s = $pres.Slides.Item($i)
      $forceThis = ($forceOnCurrent -and ($i -eq $currentSlideIndex))
      $changed = Ensure-VoteElementsOnSlide $pres $s $forceThis
      if ($changed) {
        $outFile = Join-Path $slidesOutDir ("slide-" + $i + ".png")
        $s.Export($outFile, "PNG", 1280, 720)
      }
    }
  } catch {}
}

function Set-SlideButtonVisualState($app, $pres, [int]$slideIndex, [bool]$isOpen, [int]$voteCount, [int]$ouiCount, [int]$nonCount, [int]$abstCount) {
  try {
    $total = [int]$pres.Slides.Count
    if ($slideIndex -lt 1 -or $slideIndex -gt $total) { return }

    $stateKey = "$slideIndex|$isOpen|$voteCount|$ouiCount|$nonCount|$abstCount"
    $stateChanged = ($script:lastBtnStateKey -ne $stateKey)
    $script:lastBtnStateKey = $stateKey

    $slide = $pres.Slides.Item($slideIndex)
    foreach ($shape in @($slide.Shapes)) {
      if ([string]$shape.Name -like "VoteEnDirect_BtnVote*") {
        if ($isOpen) {
          $shape.Fill.ForeColor.RGB = (Convert-ToOleRgb 234 88 12)
          $shape.Line.ForeColor.RGB = (Convert-ToOleRgb 194 65 12)
          $line1 = $SYM_STOP + " CL" + $O_CAP_CIR + "TURER & AFFICHER R" + $E_CAP + "SULTAT"
          $line2 = "(" + $voteCount + " vote(s) re" + $C_CEDIL + "u(s) " + $SYM_DASH + " Cliquez ici pour cl" + $O_CIRC + "turer)"
          $shape.TextFrame.TextRange.Text = $line1 + "`r`n" + $line2
          $shape.TextFrame.TextRange.Paragraphs(1).Font.Size = 15
          $shape.TextFrame.TextRange.Paragraphs(2).Font.Size = 11
        } else {
          $shape.Fill.ForeColor.RGB = (Convert-ToOleRgb 16 185 129)
          $shape.Line.ForeColor.RGB = (Convert-ToOleRgb 4 120 87)
          $shape.TextFrame.TextRange.Text = $TXT_LANCER_VOTE
          $shape.TextFrame.TextRange.Font.Size = 16
        }
      }
    }

    if ($stateChanged -and $null -ne $app -and [int]$app.SlideShowWindows.Count -gt 0) {
      $ssView = $app.SlideShowWindows.Item(1).View
      if ([int]$ssView.CurrentShowPosition -eq $slideIndex) {
        $ssView.GotoSlide($slideIndex)
      }
    }
  } catch {}
}

function Export-PresentationSlides($pres, $currentIndex, $forceCurrent = $false) {
  try {
    $total = [int]$pres.Slides.Count
    if ($currentIndex -lt 1 -or $currentIndex -gt $total) { return }

    if ($forceCurrent -or $script:lastExportedSlide -ne $currentIndex) {
      $script:lastExportedSlide = $currentIndex
      $s = $pres.Slides.Item($currentIndex)
      Ensure-VoteElementsOnSlide $pres $s $false | Out-Null
      $currFile = Join-Path $slidesOutDir ("slide-" + $currentIndex + ".png")
      $s.Export($currFile, "PNG", 1280, 720)

      if ($currentIndex -gt 1) {
        $prevIdx = $currentIndex - 1
        $prevFile = Join-Path $slidesOutDir ("slide-" + $prevIdx + ".png")
        if ($forceCurrent -or -not (Test-Path $prevFile)) {
          $pres.Slides.Item($prevIdx).Export($prevFile, "PNG", 1280, 720)
        }
      }
    }
  } catch {}
}

function Test-SlideButtonClicked($app, $pres, [int]$currSlide, [bool]$inSlideShow) {
  try {
    # Toujours consommer l'etat du clic gauche a chaque cycle pour eviter les clics residuels
    $keyState = [PptMouseHelper]::GetAsyncKeyState(0x01)
    $now = [DateTime]::UtcNow
    if (($now - $script:lastClickTime).TotalMilliseconds -lt 1200) {
      return $false
    }

    if (-not $inSlideShow) {
      $sel = $app.ActiveWindow.Selection
      if ($null -ne $sel -and ([int]$sel.Type -eq 2 -or [int]$sel.Type -eq 3)) {
        $sh = $sel.ShapeRange.Item(1)
        if ($null -ne $sh -and [string]$sh.Name -like "VoteEnDirect_BtnVote*") {
          $script:lastClickTime = $now
          try { $app.ActiveWindow.Selection.Unselect() } catch {}
          try {
            $sh.Visible = 0
            $sh.Visible = -1
          } catch {}
          return $true
        }
      }
    } else {
      if ($keyState -ne 0) {
        $slide = $pres.Slides.Item($currSlide)
        $btnShape = $null
        foreach ($shape in @($slide.Shapes)) {
          if ([string]$shape.Name -like "VoteEnDirect_BtnVote*") {
            $btnShape = $shape
            break
          }
        }

        if ($null -ne $btnShape) {
          $slideW = [double]$pres.PageSetup.SlideWidth
          $slideH = [double]$pres.PageSetup.SlideHeight
          if ($slideW -le 0) { $slideW = 960 }
          if ($slideH -le 0) { $slideH = 540 }

          $minX = ([double]$btnShape.Left / $slideW) - 0.03
          $maxX = (([double]$btnShape.Left + [double]$btnShape.Width) / $slideW) + 0.03
          $minY = ([double]$btnShape.Top / $slideH) - 0.04
          $maxY = (([double]$btnShape.Top + [double]$btnShape.Height) / $slideH) + 0.04

          $pt = New-Object "PptMouseHelper+POINT"
          [PptMouseHelper]::GetCursorPos([ref]$pt) | Out-Null

          $rect = New-Object "PptMouseHelper+RECT"
          $gotRect = $false
          try {
            $ssHwnd = [IntPtr]$app.SlideShowWindows.Item(1).HWND
            if ($ssHwnd -ne [IntPtr]::Zero) {
              $gotRect = [PptMouseHelper]::GetWindowRect($ssHwnd, [ref]$rect)
            }
          } catch {}

          if (-not $gotRect) {
            $fgHwnd = [PptMouseHelper]::GetForegroundWindow()
            if ($fgHwnd -ne [IntPtr]::Zero) {
              $gotRect = [PptMouseHelper]::GetWindowRect($fgHwnd, [ref]$rect)
            }
          }

          $winW = [double]($rect.Right - $rect.Left)
          $winH = [double]($rect.Bottom - $rect.Top)
          if ($gotRect -and $winW -gt 100 -and $winH -gt 100) {
            $relX = [double]($pt.X - $rect.Left) / $winW
            $relY = [double]($pt.Y - $rect.Top) / $winH
            if ($relX -ge $minX -and $relX -le $maxX -and $relY -ge $minY -and $relY -le $maxY) {
              $script:lastClickTime = $now
              return $true
            }
          }
        }
      }
    }
  } catch {}
  return $false
}

function Get-SingleSlideTextInfo($pres, $idx) {
  $title = ""
  $bodyParts = @()
  try {
    $slide = $pres.Slides.Item($idx)
    if ($slide.Shapes.HasTitle -eq -1) {
      $title = [string]$slide.Shapes.Title.TextFrame.TextRange.Text
      $title = ($title -replace "[\r\n]+", " ").Trim()
    }
    foreach ($shape in $slide.Shapes) {
      $sName = [string]$shape.Name
      if ($sName -like "VoteEnDirect_*") { continue }
      if ($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1) {
        $txt = [string]$shape.TextFrame.TextRange.Text
        $txt = ($txt -replace "[\r\n]+", " ").Trim()
        if ($txt.Length -gt 0 -and $txt -ne $title) {
          $bodyParts += $txt
        }
      }
    }
  } catch {}

  $sep = " " + $SYM_DASH + " "
  $fullBody = ($bodyParts -join $sep).Trim()
  if ($title -eq "" -and $bodyParts.Count -gt 0) {
    $title = $bodyParts[0]
    if ($title.Length -gt 110) {
      $title = $title.Substring(0, 110) + "..."
    }
  }
  if ($fullBody.Length -gt 1200) {
    $fullBody = $fullBody.Substring(0, 1200) + "..."
  }

  return @{
    title = $title
    body = $fullBody
  }
}

function Get-SlideTexts($pres, $slideIndex) {
  Export-PresentationSlides $pres $slideIndex $false
  $info = Get-SingleSlideTextInfo $pres $slideIndex
  $title = [string]$info.title
  $fullBody = [string]$info.body

  $slideObj = $pres.Slides.Item($slideIndex)
  $isVoteSlide = Test-IsVotingSlide $slideObj

  $propSlideNum = $slideIndex
  $propTitle = $title

  if ($isVoteSlide -and $slideIndex -gt 1) {
    for ($prev = $slideIndex - 1; $prev -ge 1; $prev--) {
      $prevInfo = Get-SingleSlideTextInfo $pres $prev
      $pTitle = [string]$prevInfo.title
      $pBody = [string]$prevInfo.body
      if ($pTitle -notmatch "(?i)(SULTAT DU VOTE|Proposition|Votes\s*:)") {
        $propSlideNum = $prev
        if ($pTitle.Length -gt 0) {
          $propTitle = $pTitle
        } elseif ($pBody.Length -gt 0) {
          $propTitle = $pBody
        }
        break
      }
    }
  }

  return @{
    slideTitle = $title
    slideText = $fullBody
    isVoteSlide = $isVoteSlide
    propositionSlide = $propSlideNum
    propositionTitle = $propTitle
  }
}

function Insert-ResultSlideBelow($dataJson) {
  try {
    $app = Get-RunningPptApp
    if ($null -eq $app) { return @{ ok = $false; error = "PowerPoint non connecte" } }
    $pres = $app.ActivePresentation
    $total = [int]$pres.Slides.Count

    $curr = 1
    if ([int]$app.SlideShowWindows.Count -gt 0) {
      $curr = [int]$app.SlideShowWindows.Item(1).View.CurrentShowPosition
    } else {
      try { $curr = [int]$app.ActiveWindow.View.Slide.SlideIndex } catch { $curr = [int]$dataJson.slideNumber }
    }
    if ($curr -lt 1) { $curr = 1 }
    if ($curr -gt $total) { $curr = $total }

    Set-SlideButtonVisualState $app $pres $curr $false 0 0 0 0

    $newIdx = $curr + 1
    if ($newIdx -le $total) {
      $nextInfo = Get-SingleSlideTextInfo $pres $newIdx
      if ([string]$nextInfo.title -match "SULTAT DU VOTE" -or [string]$nextInfo.body -match "SULTAT DU VOTE") {
        try { $pres.Slides.Item($newIdx).Delete() } catch {}
      }
    }

    $newSlide = $pres.Slides.Add($newIdx, 12)

    $slideW = [double]$pres.PageSetup.SlideWidth
    $slideH = [double]$pres.PageSetup.SlideHeight
    if ($slideW -le 0) { $slideW = 960 }
    if ($slideH -le 0) { $slideH = 540 }

    $qTitle = [string]$dataJson.questionTitle
    if ($qTitle.Length -eq 0) { $qTitle = "Proposition soumise au vote (Diapositive $curr)" }
    $ouiCount = [int]$dataJson.ouiCount
    $nonCount = [int]$dataJson.nonCount
    $abstCount = [int]$dataJson.abstCount
    $ouiPct = [int]$dataJson.ouiPct
    $nonPct = [int]$dataJson.nonPct
    $abstPct = [int]$dataJson.abstPct
    $totalVotes = [int]$dataJson.totalVotes
    $sessionCode = [string]$dataJson.sessionCode
    $dateStr = (Get-Date -Format "dd/MM/yyyy HH:mm")

    # 1. Bandeau Superieur
    $hdrBox = $newSlide.Shapes.AddTextbox(1, 45, 24, $slideW - 90, 90)
    $hdrRange = $hdrBox.TextFrame.TextRange
    $lineA = "$TXT_RESULTAT_HDR $curr"
    $lineC = "S" + $E_ACUTE + "ance $sessionCode  $SYM_BUL  Total : $totalVotes vote(s) exprim" + $E_ACUTE + "(s)  $SYM_BUL  " + $dateStr
    $hdrRange.Text = $lineA + "`r`n" + $qTitle + "`r`n" + $lineC
    $hdrRange.Font.Name = "Calibri"
    $hdrRange.Paragraphs(1).Font.Size = 24
    $hdrRange.Paragraphs(1).Font.Bold = -1
    $hdrRange.Paragraphs(1).Font.Color.RGB = (Convert-ToOleRgb 15 98 182)
    $hdrRange.Paragraphs(2).Font.Size = 16
    $hdrRange.Paragraphs(2).Font.Bold = -1
    $hdrRange.Paragraphs(2).Font.Color.RGB = (Convert-ToOleRgb 15 23 42)
    $hdrRange.Paragraphs(3).Font.Size = 12
    $hdrRange.Paragraphs(3).Font.Bold = 0
    $hdrRange.Paragraphs(3).Font.Color.RGB = (Convert-ToOleRgb 100 116 139)

    # 2. Encadre Verdict (ADOPTE / REJETE / EGALITE)
    $verdictText = "PROPOSITION ADOPT" + $E_CAP + "E  (OUI : $ouiPct %)"
    $verdictRgb = (Convert-ToOleRgb 16 185 129)
    if ($nonCount -gt $ouiCount) {
      $verdictText = "PROPOSITION REJET" + $E_CAP + "E  (NON : $nonPct %)"
      $verdictRgb = (Convert-ToOleRgb 225 29 72)
    } elseif ($ouiCount -eq $nonCount) {
      $verdictText = $E_CAP + "GALIT" + $E_CAP + " DES VOIX  (OUI : $ouiPct %  |  NON : $nonPct %)"
      $verdictRgb = (Convert-ToOleRgb 217 119 6)
    }

    $vBanner = $newSlide.Shapes.AddShape(5, 45, 125, $slideW - 90, 52)
    $vBanner.Fill.ForeColor.RGB = $verdictRgb
    $vBanner.Line.Visible = 0
    $vBanner.TextFrame.TextRange.Text = $verdictText
    $vBanner.TextFrame.TextRange.Font.Name = "Calibri"
    $vBanner.TextFrame.TextRange.Font.Size = 20
    $vBanner.TextFrame.TextRange.Font.Bold = -1
    $vBanner.TextFrame.TextRange.Font.Color.RGB = (Convert-ToOleRgb 255 255 255)
    $vBanner.TextFrame.TextRange.ParagraphFormat.Alignment = 2

    # 3. Les 3 Barres de Resultats : OUI / NON / ABSTENTION
    $rows = @(
      @{ label = "OUI"; count = $ouiCount; pct = $ouiPct; rgb = (Convert-ToOleRgb 16 185 129) },
      @{ label = "NON"; count = $nonCount; pct = $nonPct; rgb = (Convert-ToOleRgb 225 29 72) },
      @{ label = "ABSTENTION"; count = $abstCount; pct = $abstPct; rgb = (Convert-ToOleRgb 14 165 233) }
    )

    $startY = 200
    $rowGap = 92
    $barLeft = 225
    $maxBarW = [Math]::Max(260, $slideW - 460)

    for ($r = 0; $r -lt 3; $r++) {
      $item = $rows[$r]
      $y = $startY + ($r * $rowGap)

      $lblShape = $newSlide.Shapes.AddShape(5, 45, $y, 165, 56)
      $lblShape.Fill.ForeColor.RGB = $item.rgb
      $lblShape.Line.Visible = 0
      $lblShape.TextFrame.TextRange.Text = [string]$item.label
      $lblShape.TextFrame.TextRange.Font.Name = "Calibri"
      $lblShape.TextFrame.TextRange.Font.Size = 18
      $lblShape.TextFrame.TextRange.Font.Bold = -1
      $lblShape.TextFrame.TextRange.Font.Color.RGB = (Convert-ToOleRgb 255 255 255)
      $lblShape.TextFrame.TextRange.ParagraphFormat.Alignment = 2

      $trackShape = $newSlide.Shapes.AddShape(5, $barLeft, $y + 7, $maxBarW, 42)
      $trackShape.Fill.ForeColor.RGB = (Convert-ToOleRgb 241 245 249)
      $trackShape.Line.ForeColor.RGB = (Convert-ToOleRgb 203 213 225)

      $fillW = [Math]::Max(14, [Math]::Round(($maxBarW * [int]$item.pct) / 100.0))
      $fillShape = $newSlide.Shapes.AddShape(5, $barLeft, $y + 7, $fillW, 42)
      $fillShape.Fill.ForeColor.RGB = $item.rgb
      $fillShape.Line.Visible = 0

      $scoreBox = $newSlide.Shapes.AddTextbox(1, $barLeft + $maxBarW + 15, $y + 5, 185, 46)
      $scoreBox.TextFrame.TextRange.Text = "$($item.count) voix ($($item.pct) %)"
      $scoreBox.TextFrame.TextRange.Font.Name = "Calibri"
      $scoreBox.TextFrame.TextRange.Font.Size = 18
      $scoreBox.TextFrame.TextRange.Font.Bold = -1
      $scoreBox.TextFrame.TextRange.Font.Color.RGB = (Convert-ToOleRgb 15 23 42)
    }

    if ([int]$app.SlideShowWindows.Count -gt 0) {
      $app.SlideShowWindows.Item(1).View.GotoSlide($newIdx)
    } else {
      $app.ActiveWindow.View.GotoSlide($newIdx)
    }

    Export-PresentationSlides $pres $newIdx $true
    return @{ ok = $true; insertedSlideIndex = $newIdx }
  } catch {
    return @{ ok = $false; error = $_.Exception.Message }
  }
}

function Get-PptStatus {
  try {
    $app = Get-RunningPptApp
    if ($null -eq $app) {
      return @{ connected = $false; inSlideShow = $false; presentationName = $null; currentSlide = 1; totalSlides = 1; slideTitle = ""; slideText = ""; isVoteSlide = $false; propositionSlide = 1; propositionTitle = ""; slideButtonClicked = $false }
    }
    $presCount = [int]$app.Presentations.Count
    if ($presCount -le 0) {
      return @{ connected = $false; inSlideShow = $false; presentationName = $null; currentSlide = 1; totalSlides = 1; slideTitle = ""; slideText = ""; isVoteSlide = $false; propositionSlide = 1; propositionTitle = ""; slideButtonClicked = $false }
    }
    $pres = $app.ActivePresentation
    $presName = [string]$pres.Name
    $total = [int]$pres.Slides.Count
    if ($total -lt 1) { $total = 1 }

    $ssCount = [int]$app.SlideShowWindows.Count
    if ($ssCount -gt 0) {
      $ssView = $app.SlideShowWindows.Item(1).View
      $pos = [int]$ssView.CurrentShowPosition
      if ($pos -lt 1) { $pos = 1 }
      if ($pos -gt $total) { $pos = $total }
      $clicked = Test-SlideButtonClicked $app $pres $pos $true
      $texts = Get-SlideTexts $pres $pos
      return @{
        connected = $true
        inSlideShow = $true
        presentationName = $presName
        currentSlide = $pos
        totalSlides = $total
        slideTitle = $texts.slideTitle
        slideText = $texts.slideText
        isVoteSlide = [bool]$texts.isVoteSlide
        propositionSlide = [int]$texts.propositionSlide
        propositionTitle = [string]$texts.propositionTitle
        slideButtonClicked = $clicked
      }
    } else {
      $curr = 1
      try {
        $curr = [int]$app.ActiveWindow.View.Slide.SlideIndex
      } catch {
        $curr = 1
      }
      if ($curr -lt 1) { $curr = 1 }
      if ($curr -gt $total) { $curr = $total }
      $clicked = Test-SlideButtonClicked $app $pres $curr $false
      $texts = Get-SlideTexts $pres $curr
      return @{
        connected = $true
        inSlideShow = $false
        presentationName = $presName
        currentSlide = $curr
        totalSlides = $total
        slideTitle = $texts.slideTitle
        slideText = $texts.slideText
        isVoteSlide = [bool]$texts.isVoteSlide
        propositionSlide = [int]$texts.propositionSlide
        propositionTitle = [string]$texts.propositionTitle
        slideButtonClicked = $clicked
      }
    }
  } catch {
    return @{ connected = $false; inSlideShow = $false; presentationName = $null; currentSlide = 1; totalSlides = 1; slideTitle = ""; slideText = ""; isVoteSlide = $false; propositionSlide = 1; propositionTitle = ""; slideButtonClicked = $false }
  }
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $cmd = $line.Trim()
  if ($cmd -eq "STATUS") {
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
  elseif ($cmd -eq "SYNC_QR_SLIDES") {
    try {
      $app = Get-RunningPptApp
      if ($null -ne $app -and [int]$app.Presentations.Count -gt 0) {
        $pres = $app.ActivePresentation
        $curr = 1
        try { $curr = [int]$app.ActiveWindow.View.Slide.SlideIndex } catch { $curr = 1 }
        Ensure-VoteElementsOnSlide $pres ($pres.Slides.Item($curr)) $true | Out-Null
        Export-PresentationSlides $pres $curr $true
      }
    } catch {}
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
  elseif ($cmd.StartsWith("UPDATE_SLIDE_BTN:")) {
    $b64 = $cmd.Substring(17)
    try {
      $jsonStr = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
      $d = $jsonStr | ConvertFrom-Json
      $app = Get-RunningPptApp
      if ($null -ne $app -and [int]$app.Presentations.Count -gt 0) {
        $pres = $app.ActivePresentation
        Set-SlideButtonVisualState $app $pres ([int]$d.slideNumber) ([bool]$d.isOpen) ([int]$d.voteCount) ([int]$d.ouiCount) ([int]$d.nonCount) ([int]$d.abstCount)
      }
    } catch {}
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
  elseif ($cmd.StartsWith("INSERT_RESULT_SLIDE:")) {
    $b64 = $cmd.Substring(20)
    try {
      $jsonStr = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
      $dataObj = $jsonStr | ConvertFrom-Json
      Insert-ResultSlideBelow $dataObj | Out-Null
    } catch {}
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
  elseif ($cmd -eq "NEXT") {
    try {
      $app = Get-RunningPptApp
      if ($null -ne $app) {
        if ([int]$app.SlideShowWindows.Count -gt 0) {
          $app.SlideShowWindows.Item(1).View.Next()
        } elseif ([int]$app.Presentations.Count -gt 0) {
          $curr = [int]$app.ActiveWindow.View.Slide.SlideIndex
          $total = [int]$app.ActivePresentation.Slides.Count
          if ($curr -lt $total) {
            $app.ActiveWindow.View.GotoSlide($curr + 1)
          }
        }
      }
    } catch {}
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
  elseif ($cmd -eq "PREV") {
    try {
      $app = Get-RunningPptApp
      if ($null -ne $app) {
        if ([int]$app.SlideShowWindows.Count -gt 0) {
          $app.SlideShowWindows.Item(1).View.Previous()
        } elseif ([int]$app.Presentations.Count -gt 0) {
          $curr = [int]$app.ActiveWindow.View.Slide.SlideIndex
          if ($curr -gt 1) {
            $app.ActiveWindow.View.GotoSlide($curr - 1)
          }
        }
      }
    } catch {}
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
  elseif ($cmd.StartsWith("GOTO:")) {
    $target = 1
    [int]::TryParse($cmd.Substring(5), [ref]$target) | Out-Null
    try {
      $app = Get-RunningPptApp
      if ($null -ne $app) {
        if ([int]$app.SlideShowWindows.Count -gt 0) {
          $app.SlideShowWindows.Item(1).View.GotoSlide($target)
        } elseif ([int]$app.Presentations.Count -gt 0) {
          $app.ActiveWindow.View.GotoSlide($target)
        }
      }
    } catch {}
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
  elseif ($cmd -eq "START_SLIDESHOW") {
    try {
      $app = Get-RunningPptApp
      if ($null -ne $app -and [int]$app.Presentations.Count -gt 0) {
        if ([int]$app.SlideShowWindows.Count -eq 0) {
          $app.ActivePresentation.SlideShowSettings.Run() | Out-Null
        }
      }
    } catch {}
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
  elseif ($cmd -eq "END_SLIDESHOW") {
    try {
      $app = Get-RunningPptApp
      if ($null -ne $app -and [int]$app.SlideShowWindows.Count -gt 0) {
        $app.SlideShowWindows.Item(1).View.Exit()
      }
    } catch {}
    $st = Get-PptStatus
    Write-Output ($st | ConvertTo-Json -Compress)
  }
}
