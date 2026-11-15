import os
import tempfile
from pathlib import Path

# Must be set before any `hub` import.
_TMP = Path(tempfile.mkdtemp(prefix="workana-hub-test-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_TMP / 'test.db').as_posix()}"
os.environ["HUB_SHARED_SECRET"] = "test-secret"
os.environ["FETCHER"] = "none"

import pytest  # noqa: E402
from sqlmodel import Session, SQLModel  # noqa: E402

from hub.db import engine, init_db  # noqa: E402


@pytest.fixture(autouse=True)
def fresh_db():
    SQLModel.metadata.drop_all(engine)
    init_db()
    yield


@pytest.fixture
def session():
    with Session(engine) as s:
        yield s


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from hub.main import app

    with TestClient(app) as c:
        yield c
