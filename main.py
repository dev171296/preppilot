"""
PrepPilot backend — the Python "brain" of the app.

FastAPI turns this file into a web service: a program that sits and
waits for requests and sends back answers. Every "@app.get(...)" or
"@app.post(...)" line below is one address the service understands.
"""

import io

import httpx
from docx2txt import process as extract_docx_text
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from pypdf import PdfReader

from providers import (
    PROVIDERS,
    STT_PROVIDERS,
    STT_LANGUAGES,
    REALTIME_PROVIDERS,
    run_test,
    run_stt_test,
    run_realtime_test,
    stream_deepgram_stt,
)

app = FastAPI(title="PrepPilot API")

# The frontend (Cloudflare Pages) and this backend (Render) are two
# different origins/domains, so without this the browser would block
# every request from preppilot-2tm.pages.dev to this API. /status
# never needed this because it's served BY this same backend
# (same-origin) -- this is only needed now that a separate frontend
# calls in from outside.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://preppilot-2tm.pages.dev",
        "http://localhost:5173",  # local Vite dev server, for testing
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


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


@app.websocket("/ws/stt-stream/{provider_key}")
async def ws_stt_stream(websocket: WebSocket, provider_key: str, language: str | None = None):
    """
    A real, persistent streaming connection: the browser keeps this
    open for as long as "Live Listen" is on and pushes raw audio
    continuously; we relay it straight through to the provider (right
    now, only Deepgram supports this) and relay its transcript
    messages straight back. Unlike /api/stt-test above, there's no
    single request/response here -- the connection just stays open.
    """
    await websocket.accept()
    try:
        if provider_key == "deepgram_nova3":
            await stream_deepgram_stt(websocket, language)
        else:
            await websocket.send_text(
                '{"error": "No live-stream relay wired up for this provider"}'
            )
    except WebSocketDisconnect:
        pass
    except Exception as e:
        try:
            await websocket.send_text(f'{{"error": "{type(e).__name__}: {e}"}}')
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.post("/api/realtime-test/{provider_key}")
def api_test_realtime_provider(provider_key: str):
    """
    Realtime (speech-to-speech) providers connect browser-to-provider
    directly -- for Gemini Live, this mints a short-lived, single-use
    token server-side (our real GEMINI_API_KEY never leaves the
    server) and hands it to the browser, which then opens its own
    direct connection to Google using that token. Any other provider
    here still just returns a "not backend-testable" note.

    The real Mock Interview screen reuses this SAME endpoint
    (provider_key="gemini_live") to start its own sessions -- minting
    a token is exactly the same operation either way, so there's no
    separate "real" endpoint for it.
    """
    return run_realtime_test(provider_key)


class ResumeExtractRequest(BaseModel):
    url: str
    filename: str = ""


MAX_RESUME_TEXT_CHARS = 6000  # this is LLM context, not a full copy -- keep it bounded


@app.post("/api/extract-resume-text")
async def api_extract_resume_text(payload: ResumeExtractRequest):
    """
    Downloads a resume file from a Supabase Storage signed URL (the
    frontend already has permission to read it -- we just fetch and
    extract text, never touching Supabase's storage API ourselves) and
    pulls out its plain text, so a Mock Interview session can use it as
    context for Gemini.

    PDF text comes from pypdf; .docx from docx2txt. Old binary .doc
    files aren't supported here (that format needs heavier tooling than
    is worth adding for a fairly rare case) -- we say so clearly rather
    than silently failing or returning garbage.
    """
    ext = payload.filename.rsplit(".", 1)[-1].lower() if "." in payload.filename else ""
    if ext not in ("pdf", "docx", "doc"):
        return {"ok": False, "error": f"Unsupported file type: '{ext or 'unknown'}'"}
    if ext == "doc":
        return {
            "ok": False,
            "error": "Old .doc files aren't supported for text extraction yet -- please re-upload as PDF or .docx.",
        }

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.get(payload.url)
            resp.raise_for_status()
        content = resp.content

        if ext == "pdf":
            reader = PdfReader(io.BytesIO(content))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
        else:  # docx
            text = extract_docx_text(io.BytesIO(content))

        text = text.strip()
        if not text:
            return {"ok": False, "error": "Couldn't find any text in that file (it may be a scanned image)."}

        truncated = len(text) > MAX_RESUME_TEXT_CHARS
        return {"ok": True, "text": text[:MAX_RESUME_TEXT_CHARS], "truncated": truncated}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


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
        rows = []
        for key, p in STT_PROVIDERS.items():
            if p.get("live_stream"):
                button = f"""<button id="rec-btn-stt-{key}" onclick="toggleLiveStream('stt-{key}', '{key}')">🎙️ Live Listen</button>"""
            else:
                button = f"""<button id="rec-btn-stt-{key}" onclick="toggleListen('stt-{key}', '{key}')">🎤 Listen</button>"""
            rows.append(f"""
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
              <td>{button}</td>
            </tr>
            """)
        return "".join(rows)

    def realtime_rows():
        return "".join(
            f"""
            <tr id="row-realtime-{key}">
              <td>{p['label']}</td>
              <td>realtime (speech-to-speech)</td>
              <td class="status">not tested</td>
              <td class="ttft">—</td>
              <td class="total">—</td>
              <td class="reply">—</td>
              <td><button id="rec-btn-realtime-{key}" onclick="toggleGeminiLive('realtime-{key}', '{key}')">🎙️ Live Voice Test</button></td>
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
      <p style="font-size:13px;color:#555">Pick the language you'll speak, then click Listen (Groq/NVIDIA -- near-real-time in ~2.5s chunks, since their APIs are batch-only) or Live Listen (Deepgram -- a real continuous stream, word-by-word, with interim results shown in <em>italics</em> before they're finalized). Click Stop when done.</p>
      <table>
        <tr>
          <th>Provider</th><th>Model</th><th>Status</th>
          <th>—</th><th>Total time</th><th>Transcript</th><th></th>
        </tr>
        {stt_rows()}
      </table>

      <h3>Realtime (speech-to-speech)</h3>
      <p style="font-size:13px;color:#555">These connect the browser directly to the provider -- our server only mints a short-lived token, it never sees your audio. Click Live Voice Test and talk; Gemini should talk back.</p>
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
        // ---- Deepgram: true live streaming over a WebSocket ----
        // (as opposed to toggleListen()/listenLoop() above, which
        // re-POSTs independent ~2.5s clips to Groq/NVIDIA's batch
        // APIs -- Deepgram's API supports a real continuous stream,
        // so this one keeps a single connection open and pushes raw
        // audio the whole time "Live Listen" is on.)
        const liveStreamState = {{}};

        function downsampleTo16kPCM16(float32Samples, inputSampleRate) {{
          const ratio = inputSampleRate / 16000;
          const outLength = Math.floor(float32Samples.length / ratio);
          const pcm16 = new Int16Array(outLength);
          for (let i = 0; i < outLength; i++) {{
            const srcIndex = Math.floor(i * ratio);
            let s = Math.max(-1, Math.min(1, float32Samples[srcIndex]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }}
          return pcm16;
        }}

        async function toggleLiveStream(rowKey, providerKey) {{
          const row = document.getElementById('row-' + rowKey);
          const btn = document.getElementById('rec-btn-' + rowKey);
          const existing = liveStreamState[rowKey];

          if (existing) {{
            existing.stopping = true;
            try {{ existing.ws.close(); }} catch (e) {{}}
            try {{ existing.processor.disconnect(); }} catch (e) {{}}
            try {{ existing.source.disconnect(); }} catch (e) {{}}
            try {{ existing.audioCtx.close(); }} catch (e) {{}}
            try {{ existing.stream.getTracks().forEach((t) => t.stop()); }} catch (e) {{}}
            delete liveStreamState[rowKey];
            btn.textContent = '🎙️ Live Listen';
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

          const langSelect = document.getElementById('lang-' + rowKey);
          const language = langSelect ? langSelect.value : 'en';
          const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const ws = new WebSocket(
            `${{wsProtocol}}//${{window.location.host}}/ws/stt-stream/${{providerKey}}?language=${{encodeURIComponent(language)}}`
          );
          ws.binaryType = 'arraybuffer';

          const state = {{ ws, stream, stopping: false, finalText: '', interimText: '' }};
          liveStreamState[rowKey] = state;

          function render() {{
            const parts = [];
            if (state.finalText) parts.push(state.finalText);
            if (state.interimText) parts.push(`<em>${{state.interimText}}</em>`);
            row.querySelector('.reply').innerHTML = parts.length ? parts.join(' ') : '(listening...)';
          }}

          ws.onmessage = (event) => {{
            let data;
            try {{
              data = JSON.parse(event.data);
            }} catch (e) {{
              return;
            }}
            if (data.error) {{
              row.querySelector('.status').textContent = 'FAILED';
              row.querySelector('.status').className = 'status fail';
              row.querySelector('.reply').textContent = data.error;
              return;
            }}
            const alt = data.channel && data.channel.alternatives && data.channel.alternatives[0];
            const transcript = alt ? alt.transcript : '';
            if (!transcript) return;
            if (data.is_final) {{
              state.finalText += (state.finalText ? ' ' : '') + transcript;
              state.interimText = '';
            }} else {{
              state.interimText = transcript;
            }}
            render();
          }};

          ws.onerror = () => {{
            if (!state.stopping) {{
              row.querySelector('.status').textContent = 'FAILED';
              row.querySelector('.status').className = 'status fail';
              row.querySelector('.reply').textContent = 'Live-stream connection error.';
            }}
          }};

          ws.onopen = async () => {{
            btn.textContent = '⏹ Stop';
            row.querySelector('.status').textContent = 'listening (live)...';
            row.querySelector('.reply').textContent = '(listening...)';

            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaStreamSource(stream);
            const processor = audioCtx.createScriptProcessor(4096, 1, 1);
            state.audioCtx = audioCtx;
            state.source = source;
            state.processor = processor;

            processor.onaudioprocess = (e) => {{
              if (ws.readyState !== WebSocket.OPEN) return;
              const input = e.inputBuffer.getChannelData(0);
              const pcm16 = downsampleTo16kPCM16(input, audioCtx.sampleRate);
              ws.send(pcm16.buffer);
            }};

            source.connect(processor);
            processor.connect(audioCtx.destination);
          }};

          ws.onclose = () => {{
            if (liveStreamState[rowKey] === state) {{
              try {{ state.processor && state.processor.disconnect(); }} catch (e) {{}}
              try {{ state.source && state.source.disconnect(); }} catch (e) {{}}
              try {{ state.audioCtx && state.audioCtx.close(); }} catch (e) {{}}
              try {{ state.stream.getTracks().forEach((t) => t.stop()); }} catch (e) {{}}
              delete liveStreamState[rowKey];
              btn.textContent = '🎙️ Live Listen';
              row.querySelector('.status').textContent = 'OK';
              row.querySelector('.status').className = 'status ok';
            }}
          }};
        }}
        // ---- Gemini Live: real speech-to-speech, browser-to-Google direct ----
        // Our server only mints a short-lived, single-use token
        // (create_gemini_live_token in providers.py) -- it never
        // touches your audio. The browser then talks straight to
        // Google using Google's own JS SDK, loaded from esm.sh.
        const geminiLiveState = {{}};

        function pcm16ToBase64(int16Array) {{
          const bytes = new Uint8Array(int16Array.buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return btoa(binary);
        }}

        function base64ToInt16Array(b64) {{
          const binary = atob(b64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          return new Int16Array(bytes.buffer);
        }}

        async function toggleGeminiLive(rowKey, providerKey) {{
          const row = document.getElementById('row-' + rowKey);
          const btn = document.getElementById('rec-btn-' + rowKey);
          const existing = geminiLiveState[rowKey];

          if (existing) {{
            try {{ existing.session && existing.session.close(); }} catch (e) {{}}
            try {{ existing.processor && existing.processor.disconnect(); }} catch (e) {{}}
            try {{ existing.source && existing.source.disconnect(); }} catch (e) {{}}
            try {{ existing.micCtx && existing.micCtx.close(); }} catch (e) {{}}
            try {{ existing.playCtx && existing.playCtx.close(); }} catch (e) {{}}
            try {{ existing.stream.getTracks().forEach((t) => t.stop()); }} catch (e) {{}}
            delete geminiLiveState[rowKey];
            btn.textContent = '🎙️ Live Voice Test';
            row.querySelector('.status').textContent = 'OK';
            row.querySelector('.status').className = 'status ok';
            return;
          }}

          row.querySelector('.status').textContent = 'getting token...';
          let tokenData;
          try {{
            const res = await fetch('/api/realtime-test/' + providerKey, {{ method: 'POST' }});
            tokenData = await res.json();
          }} catch (err) {{
            row.querySelector('.status').textContent = 'FAILED';
            row.querySelector('.status').className = 'status fail';
            row.querySelector('.reply').textContent = 'Token request error: ' + err.message;
            return;
          }}
          if (!tokenData.ok) {{
            row.querySelector('.status').textContent = 'FAILED';
            row.querySelector('.status').className = 'status fail';
            row.querySelector('.reply').textContent = tokenData.error;
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

          row.querySelector('.status').textContent = 'connecting...';
          const state = {{ stream, youText: '', geminiText: '', playHead: 0 }};
          geminiLiveState[rowKey] = state;

          function render() {{
            const parts = [];
            if (state.youText) parts.push('You: ' + state.youText);
            if (state.geminiText) parts.push('Gemini: ' + state.geminiText);
            row.querySelector('.reply').textContent = parts.length ? parts.join(' | ') : '(listening...)';
          }}

          // 24kHz mono PCM16 is what Live API audio output always
          // uses, regardless of the 16kHz we send it -- per
          // ai.google.dev/gemini-api/docs/live-api/capabilities.
          const playCtx = new (window.AudioContext || window.webkitAudioContext)({{ sampleRate: 24000 }});
          state.playCtx = playCtx;

          state.scheduledSources = [];

          function playAudioChunk(int16Array) {{
            const float32 = new Float32Array(int16Array.length);
            for (let i = 0; i < int16Array.length; i++) float32[i] = int16Array[i] / 0x8000;
            const buffer = playCtx.createBuffer(1, float32.length, 24000);
            buffer.copyToChannel(float32, 0);
            const src = playCtx.createBufferSource();
            src.buffer = buffer;
            src.connect(playCtx.destination);
            const startAt = Math.max(playCtx.currentTime, state.playHead);
            src.start(startAt);
            state.playHead = startAt + buffer.duration;
            state.scheduledSources.push(src);
            src.onended = () => {{
              const i = state.scheduledSources.indexOf(src);
              if (i !== -1) state.scheduledSources.splice(i, 1);
            }};
          }}

          // Per Google's own docs: on an interruption, the client must
          // stop playback and clear queued audio itself -- the server
          // just tells you it happened, it doesn't silence your
          // speakers for you. Without this, Gemini's old (cut-off)
          // reply keeps playing over whatever you just said.
          function stopQueuedAudioForInterruption() {{
            for (const src of state.scheduledSources) {{
              try {{ src.stop(); }} catch (e) {{}}
            }}
            state.scheduledSources = [];
            state.playHead = playCtx.currentTime;
          }}

          try {{
            const {{ GoogleGenAI, Modality }} = await import('https://esm.sh/@google/genai');
            const ai = new GoogleGenAI({{ apiKey: tokenData.token }});
            const session = await ai.live.connect({{
              model: tokenData.model,
              config: {{
                responseModalities: [Modality.AUDIO],
                inputAudioTranscription: {{}},
                outputAudioTranscription: {{}},
              }},
              callbacks: {{
                onopen: () => {{
                  btn.textContent = '⏹ Stop';
                  row.querySelector('.status').textContent = 'live -- talk now';
                  row.querySelector('.status').className = 'status';
                  render();
                }},
                onmessage: (message) => {{
                  const content = message.serverContent;
                  if (!content) return;
                  if (content.interrupted) {{
                    stopQueuedAudioForInterruption();
                    state.geminiText += ' [interrupted]';
                    render();
                  }}
                  if (content.inputTranscription && content.inputTranscription.text) {{
                    state.youText += content.inputTranscription.text;
                    render();
                  }}
                  if (content.outputTranscription && content.outputTranscription.text) {{
                    state.geminiText += content.outputTranscription.text;
                    render();
                  }}
                  if (content.modelTurn && content.modelTurn.parts) {{
                    for (const part of content.modelTurn.parts) {{
                      if (part.inlineData && part.inlineData.data) {{
                        playAudioChunk(base64ToInt16Array(part.inlineData.data));
                      }}
                    }}
                  }}
                }},
                onerror: (err) => {{
                  row.querySelector('.status').textContent = 'FAILED';
                  row.querySelector('.status').className = 'status fail';
                  row.querySelector('.reply').textContent = 'Live API error: ' + (err && err.message ? err.message : err);
                }},
                onclose: () => {{
                  if (geminiLiveState[rowKey] === state) {{
                    delete geminiLiveState[rowKey];
                    btn.textContent = '🎙️ Live Voice Test';
                    row.querySelector('.status').textContent = 'OK';
                    row.querySelector('.status').className = 'status ok';
                  }}
                }},
              }},
            }});
            state.session = session;

            const micCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = micCtx.createMediaStreamSource(stream);
            const processor = micCtx.createScriptProcessor(4096, 1, 1);
            state.micCtx = micCtx;
            state.source = source;
            state.processor = processor;

            processor.onaudioprocess = (e) => {{
              const input = e.inputBuffer.getChannelData(0);
              const pcm16 = downsampleTo16kPCM16(input, micCtx.sampleRate);
              session.sendRealtimeInput({{
                audio: {{ data: pcm16ToBase64(pcm16), mimeType: 'audio/pcm;rate=16000' }},
              }});
            }};
            source.connect(processor);
            processor.connect(micCtx.destination);
          }} catch (err) {{
            row.querySelector('.status').textContent = 'FAILED';
            row.querySelector('.status').className = 'status fail';
            row.querySelector('.reply').textContent = 'Connect error: ' + err.message;
            try {{ stream.getTracks().forEach((t) => t.stop()); }} catch (e) {{}}
            delete geminiLiveState[rowKey];
          }}
        }}
      </script>
    </body>
    </html>
    """
