from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    ANTHROPIC_API_KEY: str = ""
    GEMINI_API_KEY: str = ""
    OPENAI_API_KEY: str = ""
    OLLAMA_BASE_URL: str = "http://localhost:11434"
    AI_JUDGE_PROVIDER: str = "anthropic"
    # Per-call timeout for AI judge network requests. Surfaced as HTTP 504.
    JUDGE_TIMEOUT_SECONDS: float = 30.0
    DATA_DIR: str = "./data"
    # When True, skip seeding the demo "Sample Support Bot" project on startup.
    SEED_PROJECT_DISABLED: bool = False
    # Semantic cache for reference answers. When enabled, a new question that
    # misses the exact-hash cache is matched against past questions in the same
    # project via embedding similarity; a hit above the threshold reuses the
    # cached ReferenceAnswer instead of regenerating.
    REFERENCE_SEMANTIC_CACHE_ENABLED: bool = True
    REFERENCE_SEMANTIC_CACHE_THRESHOLD: float = 0.85

    @property
    def data_path(self) -> Path:
        return Path(self.DATA_DIR).resolve()

    @property
    def db_path(self) -> Path:
        return self.data_path / "evalbot.db"

    @property
    def projects_path(self) -> Path:
        return self.data_path / "projects"

    @property
    def chroma_path(self) -> Path:
        return self.data_path / "chroma"

    @property
    def seed_path(self) -> Path:
        return Path(__file__).resolve().parent.parent / "seed"


settings = Settings()
