"""Real Anthropic SDK against a local mock server: checks the wire request and response parsing.

Not a substitute for the live API (scripts/validate.py does that), but catches SDK/kwarg/serialization
mistakes without a key or network.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import anthropic

from cutcue.assistant import Assistant

REQUESTS: list[dict] = []


def message(content, stop):
    return {"id": "msg_test", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": content,
            "stop_reason": stop, "stop_sequence": None,
            "usage": {"input_tokens": 1200, "output_tokens": 80, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}


RESPONSES = [
    message([{"type": "thinking", "thinking": "", "signature": "sig123"},
             {"type": "tool_use", "id": "toolu_1", "name": "search_project", "input": {"query": "consistency"}}], "tool_use"),
    message([{"type": "text", "text": "Nothing to propose yet."}], "end_turn"),
]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        REQUESTS.append({"path": self.path, "headers": dict(self.headers), "body": body})
        payload = json.dumps(RESPONSES[len(REQUESTS) - 1]).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def test_real_sdk_request_shape(client, services):
    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        sdk = anthropic.Anthropic(api_key="test-key", base_url=f"http://127.0.0.1:{server.server_port}", max_retries=0)
        pid = client.post("/api/projects", json={"name": "Wire"}).json()["id"]
        result = Assistant(services, client=sdk).chat(pid, "hello")
    finally:
        server.shutdown()
    assert result["reply"] == "Nothing to propose yet." and result["usage"]["api_calls"] == 2
    first, second = REQUESTS
    assert first["path"].startswith("/v1/messages")
    assert "server-side-fallback-2026-07-01" in first["headers"].get("anthropic-beta", "")
    body = first["body"]
    assert body["model"] == "claude-opus-5-5" and body["fallbacks"] == "default"
    assert body["output_config"] == {"effort": "medium"} and body["cache_control"] == {"type": "ephemeral"}
    assert {t["name"] for t in body["tools"]} >= {"search_project", "propose_edit"}
    # Second call replays the assistant turn unchanged (thinking signature kept) plus the tool result.
    replay = second["body"]["messages"]
    assert replay[1]["content"][0] == {"type": "thinking", "thinking": "", "signature": "sig123"}
    assert replay[2]["content"][0]["type"] == "tool_result" and replay[2]["content"][0]["tool_use_id"] == "toolu_1"
