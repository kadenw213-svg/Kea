"""Configuration loading.

Engineering defaults live in config/default.yaml (checked into git). Anything
the user should be able to change without a code change belongs in the
preference store (see academic_sync.preferences), not here. This module only
answers "where are things on disk" and "what did the engineering defaults
say" -- it never talks to the network.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "default.yaml"
DEFAULT_DB_PATH = REPO_ROOT / "data" / "academic_sync.db"


class CalendarConfig(BaseModel):
    target_calendar_id: str = "primary"
    color_id: str = "10"
    default_reminders_enabled: bool = False
    invite_guests: bool = False
    create_meet_links: bool = False


class DeadlinesConfig(BaseModel):
    default_due_time: str = "23:59"
    no_meaningful_duration_minutes: int = 1


class AdministrativeDatesConfig(BaseModel):
    calendarize: bool = True


class ReadingsConfig(BaseModel):
    calendarize_standalone: bool = False


class TitlesConfig(BaseModel):
    include_topic_in_class_titles: bool = True
    tentative_label_only_if_source_uses_it: bool = True


class CompletenessConfig(BaseModel):
    reference_phrases: list[str] = Field(default_factory=list)


class ExtractionConfig(BaseModel):
    llm_assist_enabled: bool = False


class LoggingConfig(BaseModel):
    level: str = "INFO"
    audit_log_path: str = "data/audit.log"


class AppConfig(BaseModel):
    timezone: str = "America/Denver"
    calendar: CalendarConfig = Field(default_factory=CalendarConfig)
    deadlines: DeadlinesConfig = Field(default_factory=DeadlinesConfig)
    administrative_dates: AdministrativeDatesConfig = Field(
        default_factory=AdministrativeDatesConfig
    )
    readings: ReadingsConfig = Field(default_factory=ReadingsConfig)
    titles: TitlesConfig = Field(default_factory=TitlesConfig)
    completeness: CompletenessConfig = Field(default_factory=CompletenessConfig)
    extraction: ExtractionConfig = Field(default_factory=ExtractionConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)


class Settings(BaseSettings):
    """Environment-derived paths. See .env.example for the full list."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    academic_sync_db_path: str | None = None
    academic_sync_config_path: str | None = None
    academic_sync_llm_api_key: str | None = None
    d2l_base_url: str | None = None


def _load_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


@lru_cache
def get_settings() -> Settings:
    return Settings()


@lru_cache
def get_config() -> AppConfig:
    settings = get_settings()
    config_path = Path(settings.academic_sync_config_path or DEFAULT_CONFIG_PATH)
    raw = _load_yaml(config_path)
    return AppConfig.model_validate(raw)


def get_db_path() -> Path:
    settings = get_settings()
    if settings.academic_sync_db_path:
        return Path(settings.academic_sync_db_path)
    return DEFAULT_DB_PATH


def get_db_url() -> str:
    db_path = get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{db_path.as_posix()}"


def clear_caches() -> None:
    """Test helper: drop cached settings/config so overrides take effect."""
    get_settings.cache_clear()
    get_config.cache_clear()
    os.environ.setdefault("_ACADEMIC_SYNC_CACHE_CLEARED", "1")
