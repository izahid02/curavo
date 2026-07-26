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

    # Secret key used to sign login tokens. CHANGE THIS before real use.
    secret_key: str = "change-me-to-a-long-random-string"
    access_token_expire_minutes: int = 60 * 8  # 8-hour shift

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
