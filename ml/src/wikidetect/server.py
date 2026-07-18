"""Long-lived local scoring server — the model loads once, then warm
requests answer in well under a second (the old stack paid a 30-60s model
load per invocation).

    wikidetect serve [--port 8756] [--model desklib]

    GET  /health            -> {"model": ..., "calibration": {...}|null}
    POST /score  {"texts": [...]}  -> {"model": ..., "scores": [...]}
    POST /detect {"text": "..."}   -> full structured finding (see detect.py)

stdlib ThreadingHTTPServer bound to 127.0.0.1 (WIKIDETECT_HOST overrides,
for containers): the GPU serializes scoring anyway, so a model lock is all
the concurrency control needed.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import config
from .detect import detect_text, get_scorer, load_calibration

_model_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    model = config.DEFAULT_MODEL

    def _reply(self, status: int, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quiet
        pass

    def do_GET(self):
        if self.path != "/health":
            return self._reply(404, {"error": "unknown path"})
        self._reply(200, {"model": self.model, "calibration": load_calibration(self.model)})

    def do_POST(self):
        try:
            length = int(self.headers.get("content-length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            return self._reply(400, {"error": "bad JSON"})
        try:
            if self.path == "/score":
                texts = req.get("texts")
                if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                    return self._reply(400, {"error": 'expected {"texts": ["...", ...]}'})
                with _model_lock:
                    scores = [round(p, 4) for p in get_scorer(self.model).score_batch(texts)]
                return self._reply(200, {"model": self.model, "scores": scores})
            if self.path == "/detect":
                text = req.get("text")
                if not isinstance(text, str) or not text.strip():
                    return self._reply(400, {"error": 'expected {"text": "..."}'})
                with _model_lock:
                    return self._reply(200, detect_text(text.strip(), model=self.model))
            return self._reply(404, {"error": "unknown path"})
        except Exception as e:  # surface scoring errors to the client
            return self._reply(500, {"error": str(e)})


def serve(port: int = config.SERVE_PORT, model: str = config.DEFAULT_MODEL):
    Handler.model = model
    print(f"loading {model}...", flush=True)
    get_scorer(model)  # pay the cold start before accepting requests
    httpd = ThreadingHTTPServer((config.SERVE_HOST, port), Handler)
    print(f"wikidetect serving {model} at http://{config.SERVE_HOST}:{port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
