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
    STT_LANGUAGES,
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
    language: str | None = None,
    audio: UploadFile | None = File(None),
):
    """
    Speech-to-text test: sends audio to the provider's transcription
    API and returns what came back. "audio" is a real recording from
    the /status page's mic button (Listen -> speak -> Stop); if none
    is attached, it falls back to a pre-recorded phrase as a plain
    connectivity check. "model" works the same way as the text-LLM
    test above. "language" (e.g. "en"/"hi") tells the provider what
    language to expect instead of guessing per chunk -- guessing is
    unreliable on short, memory-less ~2.5s chunks.
    """
    audio_bytes = await audio.read() if audio is not None else None
    filename = audio.filename if audio is not None else None
    return run_stt_test(
        provider_key,
        model,
        audio_bytes=audio_bytes,
        filename=filename,
        language=language,
    )


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

    def language_options():
        return "".join(
            f'<option value="{code}"{" selected" if code == "en" else ""}>{info["label"]}</option>'
            for code, info in STT_LANGUAGES.items()
        )

    def stt_rows():
        return "".join(
            f"""
            <tr id="row-stt-{key}">
              <td>{p['label']}</td>
              <td>
                <select id="model-stt-{key}">{model_options(p['models'])}</select>
                <select id="lang-stt-{key}" title="Language you'll speak">{language_options()}</select>
              </td>
              <td class="status">not tested</td>
              <td class="ttft">—</td>
              <td class="total">—</td>
              <td class="reply">—</td>
              <td><button id="rec-btn-stt-{key}" onclick="toggleListen('stt-{key}', '{key}')">🎤 Listen</button></td>
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
      <p style="font-size:13px;color:#555">Pick the language you'll speak (auto-detect on 2.5s chunks is unreliable, especially Hindi/Urdu), click Listen and just talk -- your mic streams in short chunks that get transcribed live and appended below as you speak. Click Stop when done. (Neither provider's API is truly continuous-streaming from a plain HTTP call, so this is near-real-time in ~2.5s chunks, not word-by-word.)</p>
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

        // rowKey -> {{ stream, listening: bool, transcript: string }} for
        // whichever STT rows are currently in "Listen" mode.
        const listenState = {{}};
        const CHUNK_MS = 2500;

        function recordOneChunk(stream) {{
          return new Promise((resolve) => {{
            const recorder = new MediaRecorder(stream);
            const chunks = [];
            recorder.ondataavailable = (e) => {{ if (e.data.size > 0) chunks.push(e.data); }};
            recorder.onstop = () => resolve(new Blob(chunks, {{ type: 'audio/webm' }}));
            recorder.start();
            setTimeout(() => {{
              if (recorder.state !== 'inactive') recorder.stop();
            }}, CHUNK_MS);
          }});
        }}

        async function transcribeChunk(rowKey, providerKey, blob) {{
          const modelSelect = document.getElementById('model-' + rowKey);
          const langSelect = document.getElementById('lang-' + rowKey);
          let url = '/api/stt-test/' + providerKey;
          const params = [];
          if (modelSelect) params.push('model=' + encodeURIComponent(modelSelect.value));
          if (langSelect) params.push('language=' + encodeURIComponent(langSelect.value));
          if (params.length) url += '?' + params.join('&');
          const formData = new FormData();
          formData.append('audio', blob, 'chunk.webm');
          const res = await fetch(url, {{ method: 'POST', body: formData }});
          return res.json();
        }}

        async function listenLoop(rowKey, providerKey) {{
          const row = document.getElementById('row-' + rowKey);
          const state = listenState[rowKey];
          let seq = 0;
          const results = {{}};
          let nextToShow = 0;
          let modelTag = '';

          function flush() {{
            while (Object.prototype.hasOwnProperty.call(results, nextToShow)) {{
              const data = results[nextToShow];
              delete results[nextToShow];
              nextToShow++;
              if (data.ok && data.text) {{
                if (data.model) modelTag = `[${{data.model}}] `;
                state.transcript += (state.transcript ? ' ' : '') + data.text;
              }} else if (!data.ok) {{
                state.transcript += (state.transcript ? ' ' : '') + `[chunk error: ${{data.error}}]`;
              }}
              // empty/silent OK chunks just add nothing
            }}
            row.querySelector('.reply').textContent = modelTag + (state.transcript || '(listening...)');
          }}

          // Recording the NEXT chunk starts right away instead of
          // waiting for the previous chunk's transcript to come back --
          // otherwise a slow model makes it look like the mic stopped
          // listening while it waits on the network.
          while (state && state.listening) {{
            const mySeq = seq++;
            const blob = await recordOneChunk(state.stream);
            if (!state.listening) break;
            transcribeChunk(rowKey, providerKey, blob)
              .then((data) => {{ results[mySeq] = data; flush(); }})
              .catch((err) => {{
                results[mySeq] = {{ ok: false, error: 'Upload error: ' + err.message }};
                flush();
              }});
          }}
        }}

        async function toggleListen(rowKey, providerKey) {{
          const row = document.getElementById('row-' + rowKey);
          const btn = document.getElementById('rec-btn-' + rowKey);
          const existing = listenState[rowKey];

          if (existing && existing.listening) {{
            // Stop listening.
            existing.listening = false;
            existing.stream.getTracks().forEach((t) => t.stop());
            delete listenState[rowKey];
            btn.textContent = '🎤 Listen';
            row.querySelector('.status').textContent = 'OK';
            row.querySelector('.status').className = 'status ok';
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

          listenState[rowKey] = {{ stream, listening: true, transcript: '' }};
          btn.textContent = '⏹ Stop';
          row.querySelector('.status').textContent = 'listening...';
          row.querySelector('.reply').textContent = '(listening...)';
          listenLoop(rowKey, providerKey);
        }}
      </script>
    </body>
    </html>
    """
