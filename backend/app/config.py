"""
Configuration for the Health Care Centre ERP backend.

Everything that might change between your computer and the pharmacy's
computer (like the database password) lives in a `.env` file, NOT in
the code. This file just reads those values.
"""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Where the database lives. Format:
    #   postgresql://USER:PASSWORD@HOST:PORT/DATABASE_NAME
    database_url: str = "postgresql://hcc:hcc@localhost:5432/hcc_erp"

    # Secret key used to sign login tokens.
    #
    # Where this value comes from, in order of priority:
    #   1. a SECRET_KEY environment variable, if one is set
    #   2. the SECRET_KEY line in backend/.env  (web/dev machines)
    #   3. the fallback string below            (the frozen desktop .exe,
    #                                            which ships no .env file)
    # BaseSettings applies that order automatically — there is nothing to
    # wire up by hand.
    #
    # The fallback is deliberately NOT a real secret: it is public in this
    # repository, so treat any install running on it as unsigned. That is an
    # acceptable trade-off for the offline single-PC desktop build, where the
    # database sits on the same machine as the person using it. Do NOT rely on
    # it if this backend is ever exposed to a network (Phase 5 cloud).
    secret_key: str = "hcc-desktop-default-key-change-in-production"
    access_token_expire_minutes: int = 60 * 8  # 8-hour shift

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
