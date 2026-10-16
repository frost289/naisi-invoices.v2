@echo off
REM Starts the LOCAL Firebase emulators (Auth 9099, Firestore 8080, viewer http://127.0.0.1:4000) with the final rules.
setlocal
cd /d "%~dp0tests"
call npm install || (echo npm install failed & pause & exit /b 1)
call npx firebase emulators:start --config ..\firebase.emulators.json --project naisi-invoices
pause
