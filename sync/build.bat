@echo off
rem Baut sync\dist\SongsTogether-Sync.exe (benötigt Python 3.10+)
cd /d "%~dp0"
if not exist .venv py -3 -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install -q -r requirements.txt
pyinstaller --noconfirm --onefile --windowed --name SongsTogether-Sync --icon icon.ico mini_sync.py
echo.
echo Fertig: %~dp0dist\SongsTogether-Sync.exe
