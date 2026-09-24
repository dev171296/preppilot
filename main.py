"""
PrepPilot backend — the Python "brain" of the app.

FastAPI turns this file into a web service: a program that sits and
waits for requests (from the web app, or from us testing it) and sends
back answers. Every "@app.get(...)" line below is one address the
service understands.
"""

from fastapi import FastAPI

# One FastAPI() object is the whole service. Everything else attaches to it.
app = FastAPI(title="PrepPilot API")


@app.get("/")
def root():
    """The home address. Visiting it proves the service is running."""
    return {"message": "PrepPilot is alive"}


@app.get("/health")
def health():
    """
    A dedicated 'is it working' address.
    Hosting platforms and monitoring tools call this on a timer to check
    the service hasn't crashed. It always does the same tiny thing, so
    it answers fast even if the rest of the app is busy.
    """
    return {"status": "ok"}
