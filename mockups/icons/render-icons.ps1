# Parly -- App Icon v2.0 rasterizer.
#
# Renders v2-sphere.svg + v2-sphere-fg.svg at native 1024 px (where Chrome
# headless gives us pixel-perfect output) and then downsamples with
# high-quality bicubic to every size required by Android (mipmap-* +
# adaptive foreground) and iOS (AppIcon.appiconset).
#
# Master-then-downsample beats per-size Chrome renders because Chrome
# silently breaks SVG filters/clip-paths at small viewports, and bicubic
# downsampling preserves the orb's anti-aliased rim.
#
# Run from anywhere:
#   pwsh mockups\icons\render-icons.ps1
#
# NB: do NOT set $ErrorActionPreference = "Stop" -- Chrome.exe writes its
# success line ("N bytes written to file ...") to STDERR, which PS 5.1
# wraps as a NativeCommandError and would abort the script even though
# the screenshot was written correctly.

$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) {
    $chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path $chrome)) { throw "No Chrome/Edge found." }

Add-Type -AssemblyName System.Drawing

$repo    = Resolve-Path "$PSScriptRoot\..\.."
$icons   = Join-Path $repo "mockups\icons"
$tmp     = Join-Path $icons ".tmp"
$iosOut  = Join-Path $repo "ios\Parly\Images.xcassets\AppIcon.appiconset"
$andRes  = Join-Path $repo "android\app\src\main\res"

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
New-Item -Path $tmp -ItemType Directory -Force | Out-Null

function Render-Master {
    param([Parameter(Mandatory)] [string] $Svg, [Parameter(Mandatory)] [string] $Out)
    $uri = "file:///" + ($Svg -replace '\\','/')
    & $chrome --headless=new --disable-gpu --hide-scrollbars `
        --force-device-scale-factor=1 `
        --default-background-color=00000000 `
        --window-size="1024,1024" `
        --virtual-time-budget=2000 `
        --screenshot="$Out" `
        "$uri" 2>&1 | Out-Null
    if (-not (Test-Path $Out)) { throw "Failed to render master $Out" }
}

function Downsample {
    param(
        [Parameter(Mandatory)] [string] $Master,
        [Parameter(Mandatory)] [string] $Out,
        [Parameter(Mandatory)] [int]    $Size
    )
    $src = [System.Drawing.Image]::FromFile($Master)
    $dst = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($dst)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality= [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)), 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $dst.Dispose()
    $src.Dispose()
    Write-Host "  $Out @ ${Size}px"
}

# Step 1: master 1024 renders.
$masterFull = Join-Path $tmp "master-full.png"
$masterFg   = Join-Path $tmp "master-fg.png"
Render-Master -Svg "$icons\v2-sphere.svg"    -Out $masterFull
Render-Master -Svg "$icons\v2-sphere-fg.svg" -Out $masterFg

# Chrome's --window-size renders the SVG one pixel short on the right
# and bottom, leaving a transparent strip. App Store rejects any alpha
# in iPhone icons, so flatten the full master onto an opaque dusk-black
# rectangle. The fg master keeps its alpha (adaptive icons require it).
function Flatten-Opaque {
    param([Parameter(Mandatory)] [string] $In, [Parameter(Mandatory)] [string] $Out)
    $src = [System.Drawing.Image]::FromFile($In)
    $dst = New-Object System.Drawing.Bitmap($src.Width, $src.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($dst)
    $g.Clear([System.Drawing.Color]::FromArgb(255, 4, 4, 6))
    $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
    $g.Dispose()
    $dst.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $dst.Dispose()
    $src.Dispose()
}
$masterFullOpaque = Join-Path $tmp "master-full-opaque.png"
Flatten-Opaque -In $masterFull -Out $masterFullOpaque
$masterFull = $masterFullOpaque

# Step 2: downsample.
Write-Host "iOS -- AppIcon.appiconset" -ForegroundColor Cyan
$ios = @(
    @{ name = "AppIcon-20@2x.png";  size = 40 },
    @{ name = "AppIcon-20@3x.png";  size = 60 },
    @{ name = "AppIcon-29@2x.png";  size = 58 },
    @{ name = "AppIcon-29@3x.png";  size = 87 },
    @{ name = "AppIcon-40@2x.png";  size = 80 },
    @{ name = "AppIcon-40@3x.png";  size = 120 },
    @{ name = "AppIcon-60@2x.png";  size = 120 },
    @{ name = "AppIcon-60@3x.png";  size = 180 },
    @{ name = "AppIcon-1024.png";   size = 1024 }
)
foreach ($e in $ios) { Downsample -Master $masterFull -Out (Join-Path $iosOut $e.name) -Size $e.size }

Write-Host "Android -- legacy ic_launcher / ic_launcher_round" -ForegroundColor Cyan
$legacy = @{ "mipmap-mdpi" = 48; "mipmap-hdpi" = 72; "mipmap-xhdpi" = 96; "mipmap-xxhdpi" = 144; "mipmap-xxxhdpi" = 192 }
foreach ($d in $legacy.Keys) {
    $size = $legacy[$d]
    $dir  = Join-Path $andRes $d
    Downsample -Master $masterFull -Out (Join-Path $dir "ic_launcher.png")       -Size $size
    Downsample -Master $masterFull -Out (Join-Path $dir "ic_launcher_round.png") -Size $size
}

Write-Host "Android -- adaptive foreground" -ForegroundColor Cyan
$fg = @{ "mipmap-mdpi" = 108; "mipmap-hdpi" = 162; "mipmap-xhdpi" = 216; "mipmap-xxhdpi" = 324; "mipmap-xxxhdpi" = 432 }
foreach ($d in $fg.Keys) {
    $dir = Join-Path $andRes $d
    Downsample -Master $masterFg -Out (Join-Path $dir "ic_launcher_foreground.png") -Size $fg[$d]
}

Remove-Item $tmp -Recurse -Force
Write-Host ""
Write-Host "Done." -ForegroundColor Green
