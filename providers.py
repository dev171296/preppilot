"""
The provider registry — one small file that knows how to talk to each
AI service. Every service here speaks the same "OpenAI-style" API
format except Gemini, which uses Google's own library.

Adding a new provider later means adding one entry to PROVIDERS and,
if it's OpenAI-style, nothing else — the same test/streaming code
handles it automatically. This is the seed of the full "provider
registry" from the plan (Settings screen, Phase 1).
"""

import os
import time
from openai import OpenAI
from google import genai

# Each entry: a human label, which model to use for the quick test,
# and how to reach it. "openai_compatible" providers all speak the
# same request format as OpenAI's own API, just at a different web
# address (base_url) with a different key.
PROVIDERS = {
    "gemini": {
        "label": "Google Gemini",
        "model": "gemini-3.5-flash-lite",
        "kind": "gemini",
    },
    "nvidia": {
        "label": "NVIDIA build",
        "model": "meta/llama-3.1-8b-instruct",
        "kind": "openai_compatible",
        "base_url": "https://integrate.api.nvidia.com/v1",
        "api_key_env": "NVIDIA_API_KEY",
    },
    "groq": {
        "label": "Groq",
        "model": "openai/gpt-oss-20b",
        "kind": "openai_compatible",
        "base_url": "https://api.groq.com/openai/v1",
        "api_key_env": "GROQ_API_KEY",
    },
}

TEST_PROMPT = "In one short sentence, say hello as if you are PrepPilot."


def run_test(provider_key: str) -> dict:
    """
    Sends the test prompt to one provider in streaming mode, and times
    two things:
      - ttft_ms: time to first word — the number that matters most for
        how "instant" the app feels
      - total_ms: time for the whole short reply to finish
    Returns a plain dict, safe to turn into JSON. Never leaks the key
    itself, even if something goes wrong.
    """
    provider = PROVIDERS.get(provider_key)
    if provider is None:
        return {"ok": False, "error": f"Unknown provider '{provider_key}'"}

    started = time.monotonic()
    first_word_at = None
    text = ""

    try:
        if provider["kind"] == "gemini":
            client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
            stream = client.models.generate_content_stream(
                model=provider["model"], contents=TEST_PROMPT
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
            stream = client.chat.completions.create(
                model=provider["model"],
                messages=[{"role": "user", "content": TEST_PROMPT}],
                stream=True,
            )
            for chunk in stream:
                piece = chunk.choices[0].delta.content
                if piece:
                    if first_word_at is None:
                        first_word_at = time.monotonic()
                    text += piece

        finished = time.monotonic()
        return {
            "ok": True,
            "ttft_ms": round((first_word_at - started) * 1000) if first_word_at else None,
            "total_ms": round((finished - started) * 1000),
            "text": text.strip(),
        }

    except Exception as e:
        # Something failed (bad key, provider down, rate limit, etc).
        # We report it plainly but never print the key itself.
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
