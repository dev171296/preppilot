"""
PrepPilot backend — the Python "brain" of the app.

FastAPI turns this file into a web service: a program that sits and
waits for requests and sends back answers. Every "@app.get(...)" or
"@app.post(...)" line below is one address the service understands.
"""

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import HTMLResponse
from providers import (
    PROVIDERS,
    STT_PROVIDERS,
    REALTIME_PROVIDERS,
    run_test,
    run_stt_test,
    run_realtime_test,
)

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
def api_test_provider(provider_key: str, model: str | None = None):
    """
    Runs a real, tiny streaming request against one text-LLM provider
    and reports how it went. This is the one place that proves a
    provider's key actually works — every new provider we add later
    gets tested through this same address, never a one-off script.
    "model" is optional: the /status page's dropdown sends whichever
    model Devanshu picked; leaving it out uses that provider's
    top-ranked (recommended) model.
    """
    return run_test(provider_key, model)


@app.post("/api/stt-test/{provider_key}")
async def api_test_stt_provider(
    provider_key: str,
    model: str | None = None,
    audio: UploadFile | None = File(None),
):
    """
    Speech-to-text test: sends audio to the provider's transcription
    API and returns what came back. "audio" is a real recording from
    the /status page's mic button (Record -> speak -> Stop); if none
    is attached, it falls back to a pre-recorded phrase as a plain
    connectivity check. "model" works the same way as the text-LLM
    test above.
    """
    audio_bytes = await audio.read() if audio is not None else None
    filename = audio.filename if audio is not None else None
    return run_stt_test(provider_key, model, audio_bytes=audio_bytes, filename=filename)


@app.post("/api/realtime-test/{provider_key}")
def api_test_realtime_provider(provider_key: str):
    """
    Realtime (speech-to-speech) providers connect browser-to-provider
    directly, so there's no backend call to make yet — this just
    returns the "not backend-testable" note for that provider.
    """
    return run_realtime_test(provider_key)


@app.get("/status", response_class=HTMLResponse)
def status_page():
    """
    The observability page: one row per AI provider slot (text LLM,
    speech-to-text, realtime), each with a Test button where a real
    backend test is possible. This is plain HTML and JavaScript with
    no build step, since its only job is to poke real services and
    show what happened.
    """

    def model_options(models):
        # First model in the list is the recommended default, so it's
        # the one pre-selected in the dropdown.
        return "".join(
            f'<option value="{m}"{" selected" if i == 0 else ""}>{m}</option>'
            for i, m in enumerate(models)
        )

    def llm_rows():
        return "".join(
            f"""
            <tr id="row-llm-{key}">
              <td>{p['label']}</td>
              <td><select id="model-llm-{key}">{model_options(p['models'])}</select></td>
              <td class="status">not tested</td>
              <td class="ttft">—</td>
              <td class="total">—</td>
              <td class="reply">—</td>
              <td><button onclick="testProvider('/api/test/', 'llm-{key}', '{key}')">Test</button></td>
            </tr>
            """
            for key, p in PROVIDERS.items()
        )

    def stt_rows():
        return "".join(
            f"""
            <tr id="row-stt-{key}">
              <td>{p['label']}</td>
              <td><select id="model-stt-{key}">{model_options(p['models'])}</select></td>
              <td class="status">not tested</td>
              <td class="ttft">—</td>
              <td class="total">—</td>
              <td class="reply">—</td>
              <td><button id="rec-btn-stt-{key}" onclick="toggleRecord('stt-{key}', '{key}')">🎤 Record</button></td>
            </tr>
            """
            for key, p in STT_PROVIDERS.items()
        )

    def realtime_rows():
        return "".join(
            f"""
            <tr id="row-realtime-{key}">
              <td>{p['label']}</td>
              <td>realtime (speech-to-speech)</td>
              <td class="status">n/a — browser only</td>
              <td class="ttft">—</td>
              <td class="total">—</td>
              <td class="reply">—</td>
              <td><button onclick="testProvider('/api/realtime-test/', 'realtime-{key}', '{key}')">Why?</button></td>
            </tr>
            """
            for key, p in REALTIME_PROVIDERS.items()
        )

    return f"""
    <html>
    <head>
      <title>PrepPilot — Provider Status</title>
      <style>
        body {{ font-family: system-ui, sans-serif; margin: 2rem; }}
        table {{ border-collapse: collapse; width: 100%; margin-bottom: 2rem; }}
        th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 14px; }}
        th {{ background: #f5f5f5; }}
        h3 {{ margin-top: 2rem; }}
        .ok {{ color: #0a7a2f; font-weight: bold; }}
        .fail {{ color: #b00020; font-weight: bold; }}
        .planned {{ color: #8a6d00; font-weight: bold; }}
      </style>
    </head>
    <body>
      <h2>PrepPilot — AI Provider Status</h2>
      <p>Click Test to send a real request to that provider and time the reply.</p>

      <h3>Text LLMs</h3>
      <table>
        <tr>
          <th>Provider</th><th>Model</th><th>Status</th>
          <th>Time to first word</th><th>Total time</th><th>Reply</th><th></th>
        </tr>
        {llm_rows()}
      </table>

      <h3>Speech-to-text (STT)</h3>
      <p style="font-size:13px;color:#555">Click Record, say something, click Stop -- your voice gets uploaded and transcribed by that provider so you can eyeball whether it heard you right.</p>
      <table>
        <tr>
          <th>Provider</th><th>Model</th><th>Status</th>
          <th>—</th><th>Total time</th><th>Transcript</th><th></th>
        </tr>
        {stt_rows()}
      </table>

      <h3>Realtime (speech-to-speech)</h3>
      <p style="font-size:13px;color:#555">These connect the browser directly to the provider — nothing for our backend to test yet.</p>
      <table>
        <tr>
          <th>Provider</th><th>Kind</th><th>Status</th>
          <th>—</th><th>—</th><th>Note</th><th></th>
        </tr>
        {realtime_rows()}
      </table>

      <script>
        function renderResult(row, data) {{
          if (data.ok) {{
            row.querySelector('.status').textContent = 'OK';
            row.querySelector('.status').className = 'status ok';
            if (data.ttft_ms !== undefined) {{
              row.querySelector('.ttft').textContent = data.ttft_ms + ' ms';
            }}
            row.querySelector('.total').textContent = data.total_ms + ' ms';
            const replyText = data.expected
              ? `heard: "${{data.text}}" (expected: "${{data.expected}}")`
              : `heard: "${{data.text}}"`;
            row.querySelector('.reply').textContent = data.model
              ? `[${{data.model}}] ${{replyText}}`
              : replyText;
          }} else if (data.planned) {{
            row.querySelector('.status').textContent = 'planned';
            row.querySelector('.status').className = 'status planned';
            row.querySelector('.reply').textContent = data.error;
          }} else {{
            row.querySelector('.status').textContent = 'FAILED';
            row.querySelector('.status').className = 'status fail';
            row.querySelector('.reply').textContent = data.error;
          }}
        }}

        async function testProvider(base, rowKey, providerKey) {{
          const row = document.getElementById('row-' + rowKey);
          row.querySelector('.status').textContent = 'testing...';
          const select = document.getElementById('model-' + rowKey);
          let url = base + providerKey;
          if (select) {{
            url += '?model=' + encodeURIComponent(select.value);
          }}
          const res = await fetch(url, {{ method: 'POST' }});
          const data = await res.json();
          renderResult(row, data);
        }}

        // rowKey -> { recorder, stream } for whichever STT row is
        // currently mid-recording.
        const activeRecordings = {{}};

        async function toggleRecord(rowKey, providerKey) {{
          const row = document.getElementById('row-' + rowKey);
          const btn = document.getElementById('rec-btn-' + rowKey);

          if (activeRecordings[rowKey]) {{
            // Already recording -- this click means Stop.
            activeRecordings[rowKey].recorder.stop();
            return;
          }}

          let stream;
          try {{
            stream = await navigator.mediaDevices.getUserMedia({{ audio: true }});
          }} catch (err) {{
            row.querySelector('.status').textContent = 'FAILED';
            row.querySelector('.status').className = 'status fail';
            row.querySelector('.reply').textContent = 'Mic error: ' + err.message;
            return;
          }}

          const recorder = new MediaRecorder(stream);
          const chunks = [];
          recorder.ondataavailable = (e) => {{ if (e.data.size > 0) chunks.push(e.data); }};

          recorder.onstop = async () => {{
            stream.getTracks().forEach((t) => t.stop());
            delete activeRecordings[rowKey];
            btn.textContent = '🎤 Record';
            btn.disabled = true;

            row.querySelector('.status').textContent = 'testing...';
            const blob = new Blob(chunks, {{ type: 'audio/webm' }});
            const select = document.getElementById('model-' + rowKey);
            let url = '/api/stt-test/' + providerKey;
            if (select) {{
              url += '?model=' + encodeURIComponent(select.value);
            }}
            const formData = new FormData();
            formData.append('audio', blob, 'recording.webm');
            try {{
              const res = await fetch(url, {{ method: 'POST', body: formData }});
              const data = await res.json();
              renderResult(row, data);
            }} catch (err) {{
              row.querySelector('.status').textContent = 'FAILED';
              row.querySelector('.status').className = 'status fail';
              row.querySelector('.reply').textContent = 'Upload error: ' + err.message;
            }} finally {{
              btn.disabled = false;
            }}
          }};

          activeRecordings[rowKey] = {{ recorder, stream }};
          recorder.start();
          btn.textContent = '⏹ Stop';
          row.querySelector('.status').textContent = 'recording... click Stop when done';

          // Safety net so a forgotten recording doesn't run forever.
          setTimeout(() => {{
            if (activeRecordings[rowKey]) {{
              activeRecordings[rowKey].recorder.stop();
            }}
          }}, 15000);
        }}
      </script>
    </body>
    </html>
    """
