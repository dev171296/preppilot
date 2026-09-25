"""
PrepPilot backend — the Python "brain" of the app.

FastAPI turns this file into a web service: a program that sits and
waits for requests and sends back answers. Every "@app.get(...)" or
"@app.post(...)" line below is one address the service understands.
"""

from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from providers import PROVIDERS, run_test

app = FastAPI(title="PrepPilot API")


@app.get("/")
def root():
    """The home address. Visiting it proves the service is running."""
    return {"message": "PrepPilot is alive"}


@app.get("/health")
def health():
    """
    A dedicated 'is it working' address. Hosting platforms call this
    on a timer to check the service hasn't crashed.
    """
    return {"status": "ok"}


@app.post("/api/test/{provider_key}")
def api_test_provider(provider_key: str):
    """
    Runs a real, tiny streaming request against one AI provider and
    reports how it went. This is the one place that proves a provider's
    key actually works — every new provider we add later gets tested
    through this same address, never a one-off script.
    """
    return run_test(provider_key)


@app.get("/status", response_class=HTMLResponse)
def status_page():
    """
    The observability page: one row per AI provider, each with a Test
    button. This is plain HTML and JavaScript with no build step, since
    its only job is to poke real services and show what happened.
    """
    rows = "".join(
        f"""
        <tr id="row-{key}">
          <td>{p['label']}</td>
          <td>{p['model']}</td>
          <td class="status">not tested</td>
          <td class="ttft">—</td>
          <td class="total">—</td>
          <td class="reply">—</td>
          <td><button onclick="testProvider('{key}')">Test</button></td>
        </tr>
        """
        for key, p in PROVIDERS.items()
    )

    return f"""
    <html>
    <head>
      <title>PrepPilot — Provider Status</title>
      <style>
        body {{ font-family: system-ui, sans-serif; margin: 2rem; }}
        table {{ border-collapse: collapse; width: 100%; }}
        th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 14px; }}
        th {{ background: #f5f5f5; }}
        .ok {{ color: #0a7a2f; font-weight: bold; }}
        .fail {{ color: #b00020; font-weight: bold; }}
      </style>
    </head>
    <body>
      <h2>PrepPilot — AI Provider Status</h2>
      <p>Click Test to send a real request to that provider and time the reply.</p>
      <table>
        <tr>
          <th>Provider</th><th>Model</th><th>Status</th>
          <th>Time to first word</th><th>Total time</th><th>Reply</th><th></th>
        </tr>
        {rows}
      </table>
      <script>
        async function testProvider(key) {{
          const row = document.getElementById('row-' + key);
          row.querySelector('.status').textContent = 'testing...';
          const res = await fetch('/api/test/' + key, {{ method: 'POST' }});
          const data = await res.json();
          if (data.ok) {{
            row.querySelector('.status').textContent = 'OK';
            row.querySelector('.status').className = 'status ok';
            row.querySelector('.ttft').textContent = data.ttft_ms + ' ms';
            row.querySelector('.total').textContent = data.total_ms + ' ms';
            row.querySelector('.reply').textContent = data.text;
          }} else {{
            row.querySelector('.status').textContent = 'FAILED';
            row.querySelector('.status').className = 'status fail';
            row.querySelector('.reply').textContent = data.error;
          }}
        }}
      </script>
    </body>
    </html>
    """
