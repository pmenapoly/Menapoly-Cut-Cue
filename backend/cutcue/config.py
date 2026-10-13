"""Menapoly Cut Cue configuration, read once from the environment (.env supported)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (KEY=VALUE lines). Existing environment variables win."""
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def _bool(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    data_dir: Path
    host: str = "127.0.0.1"
    port: int = 8000
    password: str = ""
    secret_key: str = ""
    max_upload_bytes: int = 20 * 1024**3
    # Transcription (faster-whisper, CPU int8 is the Intel Mac sweet spot)
    transcriber: str = "faster-whisper"  # faster-whisper | fixture | none
    whisper_model: str = "base"
    whisper_compute_type: str = "int8"
    whisper_language: str = ""
    cpu_threads: int = 0
    # Claude
    anthropic_api_key: str = ""
    claude_model: str = "claude-opus-5-5"
    claude_effort: str = "medium"
    claude_fallbacks: bool = True
    project_budget_usd: float = 5.0
    # Rendering
    video_encoder: str = "auto"  # auto | libx264 | h264_videotoolbox
    render_timeout_s: int = 6 * 3600
    # Cloud worker (optional, off by default)
    cloud_worker_url: str = ""
    cloud_worker_token: str = ""
    allowed_origins: list[str] = field(default_factory=list)

    @property
    def claude_enabled(self) -> bool:
        return bool(self.anthropic_api_key)

    @property
    def cloud_configured(self) -> bool:
        return bool(self.cloud_worker_url)


def load_settings() -> Settings:
    _load_dotenv(ROOT / ".env")
    data_dir = Path(os.environ.get("CUTCUE_DATA_DIR", str(ROOT / "data"))).expanduser().resolve()
    return Settings(
        data_dir=data_dir,
        host=os.environ.get("CUTCUE_HOST", "127.0.0.1"),
        port=int(os.environ.get("CUTCUE_PORT", "8000")),
        password=os.environ.get("CUTCUE_PASSWORD", ""),
        secret_key=os.environ.get("CUTCUE_SECRET_KEY", ""),
        max_upload_bytes=int(float(os.environ.get("CUTCUE_MAX_UPLOAD_GB", "20")) * 1024**3),
        transcriber=os.environ.get("CUTCUE_TRANSCRIBER", "faster-whisper"),
        whisper_model=os.environ.get("CUTCUE_WHISPER_MODEL", "base"),
        whisper_compute_type=os.environ.get("CUTCUE_WHISPER_COMPUTE_TYPE", "int8"),
        whisper_language=os.environ.get("CUTCUE_WHISPER_LANGUAGE", ""),
        cpu_threads=int(os.environ.get("CUTCUE_CPU_THREADS", "0")),
        anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        claude_model=os.environ.get("CUTCUE_CLAUDE_MODEL", "claude-opus-5-5"),
        claude_effort=os.environ.get("CUTCUE_CLAUDE_EFFORT", "medium"),
        claude_fallbacks=_bool("CUTCUE_CLAUDE_FALLBACKS", True),
        project_budget_usd=float(os.environ.get("CUTCUE_PROJECT_BUDGET_USD", "5")),
        video_encoder=os.environ.get("CUTCUE_VIDEO_ENCODER", "auto"),
        render_timeout_s=int(os.environ.get("CUTCUE_RENDER_TIMEOUT_S", str(6 * 3600))),
        cloud_worker_url=os.environ.get("CUTCUE_CLOUD_WORKER_URL", ""),
        cloud_worker_token=os.environ.get("CUTCUE_CLOUD_WORKER_TOKEN", ""),
        allowed_origins=[o for o in os.environ.get("CUTCUE_ALLOWED_ORIGINS", "").split(",") if o],
    )


settings = load_settings()
