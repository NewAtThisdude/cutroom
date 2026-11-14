@echo off
rem Cutroom on Windows: starts the server if it is not running and opens the editor. cutroom.ps1 does the work.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cutroom.ps1" %*
