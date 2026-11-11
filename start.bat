@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing Electron...
  call npm install
)
call npm start
