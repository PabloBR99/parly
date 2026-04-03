@echo off
REM Parly — Dev environment setup
REM Run this before any npx react-native command

set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
set PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator;%PATH%

echo Java:   && java -version
echo ADB:    && adb version 2>&1 | findstr "Version"
echo.

if "%1"=="" (
  echo Usage: dev.bat [run-android / emulator / shell]
  echo.
  echo   dev.bat emulator     - Launch emulator
  echo   dev.bat run-android  - Build and run on device/emulator
  echo   dev.bat shell        - Open dev shell with env set
) else if "%1"=="emulator" (
  start "" "%ANDROID_HOME%\emulator\emulator.exe" -avd Medium_Phone_API_36.1
) else if "%1"=="run-android" (
  npx react-native run-android
) else if "%1"=="shell" (
  cmd /k
)
