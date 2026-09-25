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
"""

import os
import time
import asyncio
import subprocess
import tempfile

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
            "reasoning_budget": 256,
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
# The test here is a closed loop: we synthesize a short known sentence
# with edge-tts (free, no key — the same engine the plan uses for
# default TTS), then send that audio to each STT provider and check
# whether the transcript comes back close to the original sentence.
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
STT_VOICE = "en-US-AriaNeural"

# NVIDIA's ASR models are served over gRPC (via the nvidia-riva-client
# package), not the simple REST/OpenAI-style call the LLM providers
# use. This function-id identifies which hosted model gRPC talks to;
# NVIDIA can change these per model/version, so if this test starts
# failing with an auth/not-found error, check
# https://build.nvidia.com/nvidia/parakeet-ctc-0_6b-asr/api for the
# current one before assuming the key is bad.
NVIDIA_ASR_FUNCTION_ID = "d8dd4e9b-fbf5-4fb0-9dba-8cf436c8d965"


def _get_test_audio_mp3() -> str:
    """Synthesizes (and caches) the STT test phrase as an mp3 file."""
    path = os.path.join(tempfile.gettempdir(), "preppilot_stt_test.mp3")
    if not os.path.exists(path):
        import edge_tts

        async def _synthesize():
            communicate = edge_tts.Communicate(STT_TEST_PHRASE, STT_VOICE)
            await communicate.save(path)

        asyncio.run(_synthesize())
    return path


def _mp3_to_wav16k(mp3_path: str) -> str:
    """Converts mp3 -> 16kHz mono WAV, the format Riva ASR expects."""
    wav_path = mp3_path.replace(".mp3", "_16k.wav")
    if not os.path.exists(wav_path):
        subprocess.run(
            ["ffmpeg", "-y", "-i", mp3_path, "-ar", "16000", "-ac", "1", wav_path],
            check=True,
            capture_output=True,
        )
    return wav_path


def run_stt_test(provider_key: str, model: str | None = None) -> dict:
    provider = STT_PROVIDERS.get(provider_key)
    if provider is None:
        return {"ok": False, "error": f"Unknown STT provider '{provider_key}'"}

    chosen_model = model if model in provider["models"] else provider["models"][0]
    started = time.monotonic()
    try:
        mp3_path = _get_test_audio_mp3()

        if provider["kind"] == "groq_stt":
            client = OpenAI(
                api_key=os.environ["GROQ_API_KEY"],
                base_url="https://api.groq.com/openai/v1",
            )
            with open(mp3_path, "rb") as f:
                result = client.audio.transcriptions.create(
                    model=chosen_model, file=f
                )
            text = result.text

        elif provider["kind"] == "nvidia_stt":
            import riva.client  # nvidia-riva-client package

            wav_path = _mp3_to_wav16k(mp3_path)
            with open(wav_path, "rb") as f:
                audio_bytes = f.read()

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
                language_code="en-US", max_alternatives=1
            )
            response = asr_service.offline_recognize(audio_bytes, config)
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
            "expected": STT_TEST_PHRASE,
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
