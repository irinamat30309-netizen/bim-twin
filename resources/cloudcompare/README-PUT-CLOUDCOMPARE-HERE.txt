BIM Twin -- built-in CloudCompare editor
=========================================

BIM Twin uses CloudCompare as its ready-made point-cloud editor.
To bundle CloudCompare so users don't install anything, put the portable
CloudCompare here so that this path exists:

    resources/cloudcompare/CloudCompare.exe   (Windows)

How to get it (one time):
1. Open https://www.cloudcompare.org/release/
2. Download the Windows 64-bit "Archive version: 7zip (64 bits)".
3. Extract the .7z so that CloudCompare.exe sits directly in this folder
   (i.e. resources/cloudcompare/CloudCompare.exe, with its DLLs and
   the plugins/ folder next to it).

That's it. electron-builder bundles this folder into the installer
(extraResources -> resources/cloudcompare), and when running from source
the app finds it here automatically.

Runtime search order (main.js ccBin):
  1. Settings path (cloudComparePath)
  2. CLOUDCOMPARE env var
  3. Bundled: <app>/resources/cloudcompare, packaged resources, and
     %LOCALAPPDATA%/BIMTwin-style userData/cloudcompare
  4. System install (C:/Program Files/CloudCompare, PATH)

macOS: place CloudCompare.app so that
    resources/cloudcompare/CloudCompare.app/Contents/MacOS/CloudCompare
exists. Linux: place the CloudCompare binary as
    resources/cloudcompare/CloudCompare
