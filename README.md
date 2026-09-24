# PrepPilot

An interview-prep and live-copilot platform. See the project plan doc
for the full picture (vision, PRD, architecture, roadmap).

## What's here right now

Phase 0 only: a minimal FastAPI backend with two addresses, `/` and
`/health`, so we can prove the deploy pipeline works before adding real
features.

## Running it on your own machine (optional, for learning)

```
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # then fill in your real keys
uvicorn main:app --reload
```

Then open http://127.0.0.1:8000 in a browser.
