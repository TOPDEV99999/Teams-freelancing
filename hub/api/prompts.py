"""Prompt preview for the Prompts page (one prompt per account, master as fallback)."""
from __future__ import annotations

from types import SimpleNamespace
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..models import Account, Job
from ..services import settings_store
from ..services.prompt import build_prompt

router = APIRouter(prefix="/api", tags=["prompts"])

SAMPLE_JOB = SimpleNamespace(
    id="sample", url="https://www.workana.com/job/sample", title="Desarrollo de landing page en WordPress",
    description="Necesito una landing page para mi negocio de café, con formulario de contacto y "
                "integración con WhatsApp. Diseño moderno y responsive.",
    budget_text="USD 100 - 250", skills=["WordPress", "HTML", "CSS"], category="IT & Programming",
)


class PreviewIn(BaseModel):
    account_id: str
    template: Optional[str] = None  # unsaved text from the editor; empty -> account prompt -> master
    job_id: Optional[str] = None


@router.post("/prompts/preview")
def preview(body: PreviewIn, s: Session = Depends(get_session)):
    acc = s.get(Account, body.account_id)
    if acc is None:
        raise HTTPException(404, "account not found")
    job = s.get(Job, body.job_id) if body.job_id else None
    if job is None:  # latest job assigned to this account, else latest job, else a sample
        job = (s.exec(select(Job).where(Job.assigned_account_id == acc.id).order_by(Job.fetched_at.desc())).first()
               or s.exec(select(Job).order_by(Job.fetched_at.desc())).first() or SAMPLE_JOB)
    template = ((body.template if body.template is not None else acc.prompt_template) or "").strip()
    source = "account" if template else "master"
    template = template or settings_store.get(s, "master_prompt")
    warnings = []
    if "{json_format}" not in template:
        warnings.append("{json_format} is missing - the reply may not be parseable")
    if "{job.description}" not in template:
        warnings.append("{job.description} is missing - ChatGPT won't see the job text")
    return {
        "prompt": build_prompt(template, job, acc, settings_store.get(s, "styles")),
        "source": source,
        "job": {"id": job.id, "title": job.title, "sample": job is SAMPLE_JOB},
        "warnings": warnings,
    }
