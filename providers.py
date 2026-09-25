"""
The provider registry — one small file that knows how to talk to each
AI service. Every LLM service here speaks the same "OpenAI-style" API
format except Gemini, which uses Google's own library.

This file now covers three kinds of test:
  - PROVIDERS       : text LLMs (streaming chat)
  - STT_PROVIDERS    : speech-to-text (audio in, text out)
  - REALTIME_PROVIDERS: speech-to-speech "live" models — these run
    browser-to-provider directly (see project plan), so there is no
    real backend call to test yet; the row just documents that.

Adding a new LLM provider later means adding one entry to PROVIDERS
and, if it's OpenAI-style, nothing else — the same test/streaming
code handles it automatically. This is the seed of the full "provider
registry" from the plan (Settings screen, Phase 1).

IMPORTANT — provider-level failover (design note, 25 Sep 2026):
Two NVIDIA models share the same NVIDIA_API_KEY, so they also share
that key's rate limit (RPM/TPM). If one NVIDIA model gets 429'd,
switching to a *different NVIDIA model* will not help — the whole key
is throttled. Real failover has to switch to a different PROVIDER
(e.g. NVIDIA -> Groq), not just a different model within the same
provider. This matters for the Phase 1 key vault / failover design —
noted here so it isn't forgotten, not implemented yet.

IMPORTANT — hosted model IDs go end-of-life (lesson, 25 Sep 2026):
Both "meta/llama-3.1-8b-instant" (Groq) and "meta/llama-3.1-8b-instruct"
(NVIDIA) were retired mid-project (410 Gone) while this file still
pointed at them. Hosted-model IDs aren't permanent — if a provider
test starts failing with a 404/410 instead of a real error, that's
the first thing to check, not the API key.

IMPORTANT — models are now RANKED LISTS, not one fixed string (25 Sep
2026): each provider entry has "models": [best, ..., worst] instead of
a single "model". The /status page turns this into a dropdown per
provider row, pre-selected to models[0] (the one we'd recommend by
default), so Devanshu can try an alternative without a code change.
When adding models to a list, verify them against the provider's own
current docs/catalogue page first — don't copy an ID from an old
write-up or a deprecated models list. Two models already flagged as
NOT safe to add here because they moved to enterprise-only pricing on
Groq (08/16/2026): "llama-3.1-8b-instant" and "llama-3.3-70b-versatile".

IMPORTANT — STT test audio is now a STATIC file, not synthesized live
(lesson, 25 Sep 2026): the STT test used to call the real edge-tts
online service at request time to generate the test sentence. On
Render, Microsoft's speech endpoint rejected that connection outright
(403 on the websocket handshake) — cloud/datacenter IPs get blocked
there. So the test phrase now ships as a pre-recorded file,
assets/stt_test_phrase.wav (16kHz mono, generated offline once with
espeak-ng — a real voice engine isn't needed for a smoke test, just a
consistent known phrase). This has nothing to do with edge-tts as our
planned production TTS engine for real users' devices/browsers, which
is a separate, still-valid plan — this only affects this one backend
smoke test.
"""

import os
import subprocess
import time

from openai import OpenAI
from google import genai

# ---------------------------------------------------------------------------
# Text LLM providers
# ---------------------------------------------------------------------------
# Each entry: a human label, which model to use for the quick test,
# and how to reach it. "openai_compatible" providers all speak the
# same request format as OpenAI's own API, just at a different web
# address (base_url) with a different key.
PROVIDERS = {
    "gemini": {
        "label": "Google Gemini",
        # Ranked best-first (ai.google.dev/gemini-api/docs/models, checked
        # 25 Sep 2026). Avoid gemini-2.5-flash / gemini-2.0-flash / the
        # "-preview" flash-lite build — all superseded or unstable IDs.
        "models": [
            "gemini-3.5-flash-lite",
            "gemini-3.1-flash-lite",
            "gemini-3.6-flash",
            "gemini-3.8-flash",
        ],
        "kind": "gemini",
    },
    "nvidia": {
        "label": "NVIDIA build",
        # meta/llama-3.1-8b-instruct hit end-of-life 26 Aug 2026 — the
        # list below is confirmed-live models from NVIDIA's own build
        # catalogue (checked 25 Sep 2026). No current Meta Llama model
        # could be verified, so none is listed here — don't guess one.
        "models": [
            "deepseek-ai/deepseek-v4.1-flash",
            "moonshotai/kimi-k3",
        ],
        "kind": "openai_compatible",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "api_key_env": "NVIDIA_API_KEY",
    },
    "nvidia_reasoning": {
        # A "thinking" model from the same NVIDIA build catalogue. We
        # keep the reasoning effort as low as the API allows, since
        # this is just a connectivity/latency check, not a real task.
        "label": "NVIDIA build (Nemotron, reasoning)",
        "models": [
            "nvidia/nemotron-3.5-lightning-30b-a3b",
        ],
        "kind": "openai_compatible",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "api_key_env": "NVIDIA_API_KEY",
        "extra_body": {
            "chat_template_kwargs": {"enable_thinking": True},
            # Trimmed from 256 -> 64 (25 Sep 2026): 256 "thinking" tokens
            # made this smoke test take 55+ seconds. This is just a
            # connectivity/latency check, not a real reasoning task.
            "reasoning_budget": 64,
        },
    },
    "groq": {
        "label": "Groq",
        # llama-3.1-8b-instant / llama-3.3-70b-versatile moved to
        # enterprise-committed-spend-only pricing on 08/16/2026 — kept
        # OFF this list on purpose so a free-tier key doesn't fail here.
        "models": [
            "openai/gpt-oss-20b",
            "openai/gpt-oss-120b",
        ],
        "kind": "openai_compatible",
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": "GROQ_API_KEY",
    },
}

TEST_PROMPT = "In one short sentence, say hello as if you are PrepPilot."

# Requests to providers over a flaky/blocked network should fail fast
# with a clear error, not hang the /status page's "testing..." state
# forever.
REQUEST_TIMEOUT_S = 20


def run_test(provider_key: str, model: str | None = None) -> dict:
    """
    Sends the test prompt to one provider in streaming mode, and times
    two things:
      - ttft_ms: time to first word — the number that matters most for
        how "instant" the app feels
      - total_ms: time for the whole short reply to finish
    "model" lets the caller pick any model from that provider's ranked
    list (e.g. from the /status page dropdown); it defaults to
    models[0], the one we'd recommend.
    Returns a plain dict, safe to turn into JSON. Never leaks the key
    itself, even if something goes wrong.
    """
    provider = PROVIDERS.get(provider_key)
    if provider is None:
        return {"ok": False, "error": f"Unknown provider '{provider_key}'"}

    chosen_model = model if model in provider["models"] else provider["models"][0]
    started = time.monotonic()
    first_word_at = None
    text = ""

    try:
        if provider["kind"] == "gemini":
            client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
            stream = client.models.generate_content_stream(
                model=chosen_model, contents=TEST_PROMPT
            )
            for chunk in stream:
                if chunk.text:
                    if first_word_at is None:
                        first_word_at = time.monotonic()
                    text += chunk.text

        elif provider["kind"] == "openai_compatible":
            client = OpenAI(
                api_key=os.environ[provider["api_key_env"]],
                base_url=provider["base_url"],
                timeout=REQUEST_TIMEOUT_S,
            )
            # "reasoning_effort" and similar knobs aren't part of the
            # standard OpenAI client signature, so anything extra a
            # provider needs goes through extra_body. We always ask
            # for the *lowest* reasoning effort here — this is a
            # connectivity check, not a task that needs real thinking.
            extra_body = dict(provider.get("extra_body", {}))
            if "extra_body" in provider:
                extra_body.setdefault("reasoning_effort", "low")

            kwargs = {"extra_body": extra_body} if extra_body else {}
            stream = client.chat.completions.create(
                model=chosen_model,
                messages=[{"role": "user", "content": TEST_PROMPT}],
                stream=True,
                **kwargs,
            )
            for chunk in stream:
                if not chunk.choices:
                    continue
                piece = chunk.choices[0].delta.content
                if piece:
                    if first_word_at is None:
                        first_word_at = time.monotonic()
                    text += piece

        finished = time.monotonic()
        return {
            "ok": True,
            "model": chosen_model,
            "ttft_ms": round((first_word_at - started) * 1000) if first_word_at else None,
            "total_ms": round((finished - started) * 1000),
            "text": text.strip(),
        }

    except Exception as e:
        # Something failed (bad key, provider down, rate limit, etc).
        # We report it plainly but never print the key itself.
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---------------------------------------------------------------------------
# Speech-to-text (STT) providers
# ---------------------------------------------------------------------------
# The test here is a closed loop: send a known, pre-recorded sentence
# (see the STATIC test audio note up top) to each STT provider and
# check whether the transcript comes back close to the original.
STT_PROVIDERS = {
    "groq_whisper": {
        "label": "Groq (Whisper)",
        # Ranked best-first (console.groq.com/docs/models, checked 25
        # Sep 2026) — turbo is faster and is what we'd default to.
        "models": ["whisper-large-v3-turbo", "whisper-large-v3"],
        "kind": "groq_stt",
    },
    "nvidia_parakeet": {
        "label": "NVIDIA build (Parakeet ASR)",
        # Only one verified model for this slot right now — see
        # NVIDIA_ASR_FUNCTION_ID below, which is tied to this model.
        "models": ["parakeet-ctc-0.6b-asr"],
        "kind": "nvidia_stt",
    },
}

STT_TEST_PHRASE = "PrepPilot is testing speech recognition."

# Fallback audio if the browser mic isn't used (e.g. a quick backend
# smoke test with no recording attached) — pre-recorded once, offline,
# with espeak-ng. 16kHz mono WAV, which is also exactly the format
# NVIDIA's Riva ASR expects.
STT_TEST_AUDIO_PATH = os.path.join(
    os.path.dirname(__file__), "assets", "stt_test_phrase.wav"
)

# NVIDIA's ASR models are served over gRPC (via the nvidia-riva-client
# package), not the simple REST/OpenAI-style call the LLM providers
# use. This function-id identifies which hosted model gRPC talks to;
# NVIDIA can change these per model/version, so if this test starts
# failing with an auth/not-found error, check
# https://build.nvidia.com/nvidia/parakeet-ctc-0_6b-asr/api for the
# current one before assuming the key is bad.
NVIDIA_ASR_FUNCTION_ID = "d8dd4e9b-fbf5-4fb0-9dba-8cf436c8d965"
NVIDIA_ASR_SAMPLE_RATE_HZ = 16000


def _to_wav16k_bytes(audio_bytes: bytes) -> bytes:
    """
    Converts whatever audio format the browser's mic recording came in
    (webm/opus, ogg, etc) into 16kHz mono WAV -- the exact format
    NVIDIA's Riva ASR expects. Works fine on an already-16k WAV too
    (ffmpeg just passes it through), so we always run mic audio and
    the static fallback file through this the same way.
    """
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", "pipe:0", "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
        input=audio_bytes,
        capture_output=True,
        check=True,
    )
    return result.stdout


# STT language hint -> what each provider actually wants. Whisper
# takes a plain ISO-639-1 code; Riva wants a BCP-47 locale. Auto-detect
# (no hint) sounds appealing but is unreliable on short, independent
# ~2.5s chunks with no memory of the previous chunk -- Whisper in
# particular keeps re-guessing per chunk and flips between Hindi and
# Urdu (near-identical spoken languages, different scripts) or
# produces gibberish. Telling it the language up front fixes that.
# NOTE: NVIDIA's hosted Parakeet model is (as far as we've verified)
# English-only -- picking Hindi for it may just fail; that's a real
# answer from NVIDIA, not something to hide.
STT_LANGUAGES = {
    "en": {"label": "English", "whisper": "en", "riva": "en-US"},
    "hi": {"label": "Hindi", "whisper": "hi", "riva": "hi-IN"},
}
DEFAULT_STT_LANGUAGE = "en"


def run_stt_test(
    provider_key: str,
    model: str | None = None,
    audio_bytes: bytes | None = None,
    filename: str | None = None,
    language: str | None = None,
) -> dict:
    """
    "audio_bytes" is the actual recording from the /status page's mic
    button (whatever format the browser's MediaRecorder produced --
    usually webm/opus). If it's missing (e.g. called without a
    recording attached), we fall back to the pre-recorded static
    phrase so this still works as a plain connectivity smoke test.
    When testing a real mic recording, "expected" is left out of the
    result since we don't know in advance what was said -- you just
    eyeball whether the transcript looks right.
    "language" is one of STT_LANGUAGES's keys (e.g. "en"/"hi"); it
    defaults to English if missing or unrecognized.
    """
    lang = STT_LANGUAGES.get(language, STT_LANGUAGES[DEFAULT_STT_LANGUAGE])
    provider = STT_PROVIDERS.get(provider_key)
    if provider is None:
        return {"ok": False, "error": f"Unknown STT provider '{provider_key}'"}

    chosen_model = model if model in provider["models"] else provider["models"][0]
    started = time.monotonic()
    try:
        expected = None
        if audio_bytes is None:
            if not os.path.exists(STT_TEST_AUDIO_PATH):
                return {
                    "ok": False,
                    "error": f"Missing test audio file at {STT_TEST_AUDIO_PATH}",
                }
            with open(STT_TEST_AUDIO_PATH, "rb") as f:
                audio_bytes = f.read()
            filename = filename or "stt_test_phrase.wav"
            expected = STT_TEST_PHRASE

        if provider["kind"] == "groq_stt":
            client = OpenAI(
                api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1",
                timeout=REQUEST_TIMEOUT_S,
            )
            result = client.audio.transcriptions.create(
                model=chosen_model,
                file=(filename or "recording.webm", audio_bytes),
                language=lang["whisper"],
            )
            text = result.text

        elif provider["kind"] == "nvidia_stt":
            import riva.client  # nvidia-riva-client package

            wav_bytes = _to_wav16k_bytes(audio_bytes)

            auth = riva.client.Auth(
                uri="grpc.nvcf.nvidia.com:443",
                use_ssl=True,
                metadata_args=[
                    ["function-id", NVIDIA_ASR_FUNCTION_ID],
                    ["authorization", f"Bearer {os.environ['NVIDIA_API_KEY']}"],
                ],
            )
            asr_service = riva.client.ASRService(auth)
            config = riva.client.RecognitionConfig(
                language_code=lang["riva"],
                max_alternatives=1,
                sample_rate_hertz=NVIDIA_ASR_SAMPLE_RATE_HZ,
            )
            response = asr_service.offline_recognize(wav_bytes, config)
            text = (
                response.results[0].alternatives[0].transcript
                if response.results
                else ""
            )

        else:
            return {"ok": False, "error": f"Unhandled STT kind '{provider['kind']}'"}

        finished = time.monotonic()
        return {
            "ok": True,
            "model": chosen_model,
            "total_ms": round((finished - started) * 1000),
            "text": text.strip(),
            "expected": expected,
        }

    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---------------------------------------------------------------------------
# Realtime (speech-to-speech) providers
# ---------------------------------------------------------------------------
# Per the plan's design note: for the mock interview, the browser talks
# directly to Gemini Live using a short-lived token — no audio ever
# passes through our server. So there's no backend call to test here
# yet; this row exists so the status page lists every configured
# provider slot, and says plainly why it can't be "tested" like the
# others. Real testing happens in the browser once the Phase 4 voice
# mock screen exists.
REALTIME_PROVIDERS = {
    "gemini_live": {
        "label": "Gemini Live (realtime speech-to-speech)",
        "note": (
            "Browser talks to Gemini Live directly (no audio through our "
            "server) — nothing for the backend to test. Will be tested "
            "live in the browser once the Phase 4 voice-mock screen exists."
        ),
    },
}


def run_realtime_test(provider_key: str) -> dict:
    provider = REALTIME_PROVIDERS.get(provider_key)
    if provider is None:
        return {"ok": False, "error": f"Unknown realtime provider '{provider_key}'"}
    return {"ok": False, "planned": True, "error": provider["note"]}
