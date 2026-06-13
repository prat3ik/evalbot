"""Standalone tests for the chatbot connector core.

Exercises template rendering, JSONPath extraction, the provider presets, and a
live render -> HTTP -> extract round-trip against a mock OpenAI-shaped server.

Loads ``app/chatbot_client.py`` directly (it imports only the stdlib at module
load), so this runs with the system Python without installing the server's
dependencies:

    python3 server/test_chatbot_connector.py
"""

import importlib.util
import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# Load the connector core directly, bypassing the heavyweight `app` package.
_MODULE_PATH = Path(__file__).parent / "app" / "chatbot_client.py"
_spec = importlib.util.spec_from_file_location("chatbot_client", _MODULE_PATH)
cc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cc)

PRESETS = {p["id"]: p for p in cc.PRESETS}


def test_single_turn_question_template():
    body = cc.render_request_template(
        '{"question": "{{question}}"}', question='hi "there"\nyo'
    )
    assert body == {"question": 'hi "there"\nyo'}, body


def test_openai_preset_messages_single_turn():
    body = cc.render_request_template(PRESETS["openai"]["request_template"], question="ping")
    assert body["model"] == "gpt-4o"
    assert body["stream"] is False
    assert body["messages"] == [{"role": "user", "content": "ping"}], body["messages"]


def test_openai_preset_messages_multi_turn():
    turns = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello!"},
        {"role": "user", "content": "what's 2+2?"},
    ]
    body = cc.render_request_template(
        PRESETS["openai"]["request_template"], question="what's 2+2?", turns=turns
    )
    assert body["messages"] == turns, body["messages"]


def test_all_presets_render_valid_json():
    for pid, p in PRESETS.items():
        body = cc.render_request_template(p["request_template"], question="x")
        assert isinstance(body, (dict, list)), (pid, body)


def test_jsonpath_and_token_extraction():
    data = {
        "choices": [{"message": {"content": "PONG"}}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1, "total_tokens": 4},
    }
    p = PRESETS["openai"]
    assert cc.jsonpath_get(data, p["response_path"]) == "PONG"
    assert cc.coerce_int(cc.jsonpath_get(data, p["tokens_prompt_path"])) == 3
    assert cc.coerce_int(cc.jsonpath_get(data, p["tokens_total_path"])) == 4


class _MockOpenAI(BaseHTTPRequestHandler):
    """Minimal OpenAI Chat Completions look-alike that echoes the last turn."""

    def log_message(self, *_a):  # keep test output clean
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        req = json.loads(self.rfile.read(length))
        # The auth header from the preset's headers_json must arrive intact.
        self._auth_ok = self.headers.get("Authorization") == "Bearer <OPENAI_API_KEY>"
        last = req["messages"][-1]["content"]
        resp = {
            "choices": [{"message": {"role": "assistant", "content": f"echo: {last}"}}],
            "usage": {"prompt_tokens": 7, "completion_tokens": 2, "total_tokens": 9},
        }
        payload = json.dumps(resp).encode()
        self.send_response(200 if self._auth_ok else 401)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def test_live_round_trip_against_mock_openai():
    server = HTTPServer(("127.0.0.1", 0), _MockOpenAI)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        p = PRESETS["openai"]
        body = cc.render_request_template(p["request_template"], question="ping")
        headers = json.loads(p["headers_json"])
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json", **headers},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as r:
            data = json.loads(r.read())
        assert cc.extract_reply_text(data, p["response_path"]) == "echo: ping"
        assert cc.coerce_int(cc.jsonpath_get(data, p["tokens_prompt_path"])) == 7
        assert cc.coerce_int(cc.jsonpath_get(data, p["tokens_total_path"])) == 9
    finally:
        server.shutdown()


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"PASS  {t.__name__}")
    print(f"\nAll {len(tests)} connector tests passed.")


if __name__ == "__main__":
    main()
