@echo off
rem Builds the app, installs it on a USB phone (or starts the Android16 emulator), and opens it.
setlocal
cd /d "%~dp0"

set "JAVA_HOME=%LOCALAPPDATA%\Programs\jdk-17"
set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "PATH=%JAVA_HOME%\bin;%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator;%PATH%"

if not exist node_modules call npm install || goto :fail

rem Use a connected phone or running emulator if there is one; otherwise start Android16.
adb start-server >nul 2>&1
set "DEVICES="
for /f "skip=1 tokens=2" %%s in ('adb devices') do if "%%s"=="device" set "DEVICES=1"
if defined DEVICES goto :build

echo No phone or emulator found. Starting the Android16 emulator (headless; windowed mode hangs on this PC)...
start "Android16 emulator" /min emulator -avd Android16 -no-window -no-boot-anim -no-snapshot -gpu swiftshader_indirect
echo Waiting for Android to finish booting...
set /a TRIES=0
:boot
set /a TRIES+=1
if %TRIES% gtr 100 goto :bootfail
set "BOOTED="
for /f %%b in ('adb shell getprop sys.boot_completed 2^>nul') do set "BOOTED=%%b"
if "%BOOTED%"=="1" goto :build
timeout /t 3 /nobreak >nul
goto :boot

:build
echo Building the web app and syncing it into Android...
call npm run android:sync || goto :fail

echo Installing the debug app...
pushd android
call "%~dp0android\gradlew.bat" installDebug
if errorlevel 1 (
  popd
  goto :fail
)
popd

adb shell am start -n com.astra.spaceflightbuilder/.MainActivity
echo Done. The app is open on the device.
echo When finished, run stop-android.cmd to stop the emulator, adb and Gradle.
exit /b 0

:bootfail
echo Emulator did not boot in time. Run stop-android.cmd to clean up.
exit /b 1

:fail
echo.
echo Something failed above.
pause
exit /b 1
