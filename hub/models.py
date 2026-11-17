"""SQLModel tables. All datetimes are stored as naive UTC."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import Column, DateTime, JSON, UniqueConstraint
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class JobStatus:
    NEW = "new"
    GENERATING = "generating"
    DRAFTED = "drafted"
    SENT = "sent"
    SKIPPED = "skipped"
    ERROR = "error"


class SubStatus:
    QUEUED = "queued"
    SENDING = "sending"
    SENT = "sent"
    FAILED = "failed"


OUTCOMES = ("none", "replied", "interview", "hired", "rejected")


class Account(SQLModel, table=True):
    __tablename__ = "accounts"
    id: str = Field(primary_key=True)
    display_name: str = ""
    chrome_profile: str = ""
    profile_text: str = ""
    prompt_template: str = ""  # empty = use the master prompt
    categories: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    min_budget: Optional[float] = None
    default_rate: Optional[float] = None
    currency: str = "USD"  # currency of this Workana account's bids: USD | BRL | MXN
    daily_limit: int = 10
    min_delay_seconds: int = 300
    active: bool = True
    auto_generate: bool = False
    paused: bool = False
    pause_reason: Optional[str] = None
    ext_connected: bool = False
    last_seen_at: Optional[datetime] = Field(default=None, sa_type=DateTime)


class Job(SQLModel, table=True):
    __tablename__ = "jobs"
    id: str = Field(primary_key=True)
    url: str = ""
    title: str = ""
    description: str = ""
    budget_text: str = ""
    budget_min: Optional[float] = None
    budget_max: Optional[float] = None
    category: Optional[str] = None
    skills: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    client_info: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    posted_at: Optional[datetime] = Field(default=None, sa_type=DateTime)
    fetched_at: datetime = Field(default_factory=utcnow, index=True, sa_type=DateTime)
    status: str = Field(default=JobStatus.NEW, index=True)
    assigned_account_id: Optional[str] = Field(default=None, foreign_key="accounts.id", index=True)
    # Accounts that should bid on this job (multi-account). Empty = just assigned_account_id.
    target_accounts: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    # Pre-assigned pipeline: queue each account's submission automatically once its drafts are ready.
    auto_send: bool = False
    auto_style: str = ""  # style used by auto_send ("" = first style)
    locked: bool = False
    last_error: Optional[str] = None


class Draft(SQLModel, table=True):
    __tablename__ = "drafts"
    id: Optional[int] = Field(default=None, primary_key=True)
    job_id: str = Field(foreign_key="jobs.id", index=True)
    account_id: str = Field(foreign_key="accounts.id")
    style: str
    text: str
    suggested_price: Optional[float] = None
    suggested_days: Optional[int] = None
    created_at: datetime = Field(default_factory=utcnow, sa_type=DateTime)
    edited: bool = False


class Submission(SQLModel, table=True):
    __tablename__ = "submissions"
    # DB-level guarantee: one submission per (job, account), ever.
    __table_args__ = (UniqueConstraint("job_id", "account_id", name="uq_submission_job_account"),)
    id: Optional[int] = Field(default=None, primary_key=True)
    job_id: str = Field(foreign_key="jobs.id", index=True)
    account_id: str = Field(foreign_key="accounts.id", index=True)
    draft_id: Optional[int] = Field(default=None, foreign_key="drafts.id")
    style: Optional[str] = None
    final_text: str
    price: float  # amount typed into Workana, in `currency`
    currency: str = "USD"
    days: int
    status: str = Field(default=SubStatus.QUEUED, index=True)
    error: Optional[str] = None
    progress: Optional[str] = None
    requested_at: datetime = Field(default_factory=utcnow, sa_type=DateTime)
    dispatched_at: Optional[datetime] = Field(default=None, sa_type=DateTime)
    sent_at: Optional[datetime] = Field(default=None, sa_type=DateTime)
    outcome: str = "none"
    # Queued automatically (auto-send) rather than by a click.
    auto: bool = False
    # Review window: not dispatched before this time (auto-send gives you time to cancel).
    hold_until: Optional[datetime] = Field(default=None, sa_type=DateTime)


class Setting(SQLModel, table=True):
    __tablename__ = "settings"
    key: str = Field(primary_key=True)
    value: Any = Field(default=None, sa_column=Column(JSON))


class Event(SQLModel, table=True):
    __tablename__ = "events"
    id: Optional[int] = Field(default=None, primary_key=True)
    ts: datetime = Field(default_factory=utcnow, index=True, sa_type=DateTime)
    kind: str = Field(index=True)  # fetch | generate | submit | ext | system
    level: str = "info"  # info | warn | error
    message: str
    job_id: Optional[str] = None
    account_id: Optional[str] = None


class Notice(SQLModel, table=True):
    """A Workana message / notification seen by an account's extension (or a test notice)."""
    __tablename__ = "notices"
    id: Optional[int] = Field(default=None, primary_key=True)
    ts: datetime = Field(default_factory=utcnow, index=True, sa_type=DateTime)
    account_id: Optional[str] = Field(default=None, index=True)
    kind: str = "message"  # message | notification | test
    key: str = Field(default="", index=True)  # de-duplication key from the extension
    title: str = ""
    body: str = ""
    url: str = ""
    job_id: Optional[str] = Field(default=None, index=True)
    read: bool = False


class Conversation(SQLModel, table=True):
    """One Workana conversation of an account (/inbox/<slug>, usually the project's slug)."""
    __tablename__ = "conversations"
    __table_args__ = (UniqueConstraint("account_id", "slug"),)
    id: Optional[int] = Field(default=None, primary_key=True)
    account_id: str = Field(index=True)
    slug: str = Field(index=True)
    name: str = ""  # the other person (client)
    title: str = ""  # project title
    snippet: str = ""  # last line shown in Workana's inbox list
    unread: bool = False
    updated_at: datetime = Field(default_factory=utcnow, index=True, sa_type=DateTime)
    synced_at: Optional[datetime] = Field(default=None, sa_type=DateTime)  # last time the messages were read
    last_error: str = ""
    parsed_v: int = 0  # reader version that produced the stored messages (2 = Workana's verified markup)
    client_hint: bool = False  # Workana's conversation list shows a new line that isn't yours (not read yet)


class Message(SQLModel, table=True):
    """A message of a conversation as read from Workana by the account's extension."""
    __tablename__ = "messages"
    id: Optional[int] = Field(default=None, primary_key=True)
    account_id: str = Field(index=True)
    slug: str = Field(index=True)
    key: str = Field(default="", index=True)
    pos: int = 0  # order inside the conversation
    author: str = ""
    mine: bool = False
    text: str = ""
    time_text: str = ""
    first_seen: datetime = Field(default_factory=utcnow, sa_type=DateTime)
