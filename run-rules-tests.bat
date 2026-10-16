@echo off
REM Runs the Firestore rules tests against the FINAL rules on a LOCAL emulator. Uses fake data only. Never touches the live project.
setlocal
cd /d "%~dp0tests"
where node >nul 2>nul || (echo Node.js 20 or newer is not installed. Install it from nodejs.org, then run this again. & pause & exit /b 1)
where java >nul 2>nul || (echo Java 11 or newer is not installed. Install it ^(for example Temurin from adoptium.net^), then run this again. & pause & exit /b 1)
call npm install || (echo npm install failed & pause & exit /b 1)
echo.
echo Running rules tests. The first run downloads the Firestore emulator ^(about 60 MB^).
call npm run test:rules > rules-test-output.txt 2>&1
type rules-test-output.txt
echo.
echo ===== Saved to tests\rules-test-output.txt - send that file back. =====
pause
