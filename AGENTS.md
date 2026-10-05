# Project instructions

## Python environment

- This repository already has a working Windows virtual environment at `.venv`. Do not recreate, move, or reinstall it unless the user explicitly asks.
- Run every project Python command with `.\.venv\Scripts\python.exe` explicitly. Do not rely on `Activate.ps1`, because Codex tool commands run in fresh PowerShell processes and activation does not persist between calls.
- The virtual environment launcher delegates to a base Python under `AppData\Local\Programs`. If a sandboxed command reports `Access is denied` or `Unable to create process`, retry the same scoped command with sandbox escalation; do not treat that message alone as evidence that `.venv` is broken.
- Do not substitute the Codex bundled Python runtime for project execution. It does not include this project's PyTorch installation.

## Verification commands

- Python and accelerator check: `.\.venv\Scripts\python.exe -c "import sys, torch; print(sys.version); print(torch.__version__); print(torch.cuda.is_available())"`
- Test suite: `.\.venv\Scripts\python.exe -m unittest discover -s tests -v`
- Model service: `.\.venv\Scripts\python.exe scripts\serve_stroke_model.py`
- Static frontend: `.\.venv\Scripts\python.exe -m http.server 8000`
