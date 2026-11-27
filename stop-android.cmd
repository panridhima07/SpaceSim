@echo off
rem Stops what run-android.cmd leaves running: the emulator, adb and the Gradle daemon.
setlocal
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "JAVA_HOME=%LOCALAPPDATA%\Programs\jdk-17"
set "PATH=%ANDROID_HOME%\platform-tools;%JAVA_HOME%\bin;%PATH%"
for /f "tokens=1" %%d in ('adb devices 2^>nul ^| findstr /b "emulator-"') do adb -s %%d emu kill
if exist "%~dp0android\gradlew.bat" call "%~dp0android\gradlew.bat" -p "%~dp0android" --stop
adb kill-server >nul 2>&1
taskkill /f /im qemu-system-x86_64.exe >nul 2>&1
echo Android emulator, adb and Gradle daemon stopped.
exit /b 0
