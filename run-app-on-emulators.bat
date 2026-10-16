@echo off
REM Run start-emulators.bat in another window FIRST. This seeds fake data and starts the app against the emulators.
setlocal
cd /d "%~dp0"
call npm ci || (echo npm ci failed & pause & exit /b 1)
node tools\seed-emulator.mjs || (echo Seeding failed - is start-emulators.bat running? & pause & exit /b 1)
set VITE_USE_EMULATORS=true
echo.
echo Open the address shown below (usually http://localhost:5173) and log in with email + password Passw0rd! using one of:
echo mgr@example.com  rep1@example.com  rep2@example.com  deliv@example.com  stranger@example.com
call npm run dev
