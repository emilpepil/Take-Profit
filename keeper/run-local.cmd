@echo off
setlocal
cd /d "%~dp0.."

rem This process only reads Monad state and may send Telegram alerts.
rem It never signs or broadcasts a blockchain transaction.
call npm.cmd run keeper:watch >> keeper\watch.log 2>&1
