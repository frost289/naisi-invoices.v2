@echo off
REM Run start-emulators.bat in another window FIRST. This seeds fake data and starts the app against the emulators.
setlocal
cd /d "%~dp0"
call npm install || (echo npm install failed & pause & exit /b 1)
node tools\seed-emulator.mjs || (echo Seeding failed - is start-emulators.bat running? & pause & exit /b 1)
set VITE_USE_EMULATORS=true
echo.
echo Open the address shown below (usually http://localhost:5173). Sign in with Google, choose "Add new account" in the emulator popup,
echo and type one of: mgr@example.com  rep1@example.com  rep2@example.com  deliv@example.com  stranger@example.com
call npm run dev
