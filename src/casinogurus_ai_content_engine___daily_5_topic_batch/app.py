"""FastAPI backend for the CasinoGurus content engine (production).

Replaces the stdlib ``server.py``. Same JSON API the Next.js dashboard already
speaks, now with:
  * Supabase-Auth JWT verification on every ``/api`` route (see auth.py)
  * a Postgres-backed store (see storage.py / db.py)
  * CORS for the Firebase-hosted frontend
  * a health check for the host (Render)

Run locally:
    uv run uvicorn casinogurus_ai_content_engine___daily_5_topic_batch.app:app --reload --port 8000

Endpoints (all under /api require a valid token):
    GET  /healthz
    GET  /api/formats                         -> enabled content-type/format catalog
    GET  /api/registry                        -> full catalog (admin) + task variants
    POST/PUT/DELETE /api/content-types[/{id}] -> content-type master CRUD
    POST/PUT/DELETE /api/formats[/{id}]       -> format master CRUD
    GET  /api/clients
    POST /api/clients
    GET  /api/clients/{client_id}
    PUT  /api/clients/{client_id}             -> profile edits append version N+1
    GET  /api/runs[?client_id=]
    GET  /api/batches[?client_id=]
    GET  /api/batches/{id}
    GET  /api/batches/{id}/download           -> docx ZIP
    GET  /api/latest
    GET  /api/packages/{pid}/image
    POST /api/packages/{pid}/image[?force=1]
    POST /api/packages/{pid}/feedback         -> shortlist/approve/reject event
    POST /api/run-agent                       -> {client_id, content_type, format}
    GET  /api/agent-logs                      -> SSE
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import re
import subprocess
import sys
import threading
import zipfile
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ValidationError

from casinogurus_ai_content_engine___daily_5_topic_batch.auth import require_user
from casinogurus_ai_content_engine___daily_5_topic_batch.db import (
    _PROJECT_ROOT,
    connection,
    init_schema,
)
from casinogurus_ai_content_engine___daily_5_topic_batch import storage
from casinogurus_ai_content_engine___daily_5_topic_batch.profile import ClientProfile
from casinogurus_ai_content_engine___daily_5_topic_batch.registry import AVAILABLE_TASK_VARIANTS
from casinogurus_ai_content_engine___daily_5_topic_batch.storage import get_image

PACKAGE = "casinogurus_ai_content_engine___daily_5_topic_batch"
LOG_PATH = os.path.join(_PROJECT_ROOT, "agent.log")

# Single-run guard: at most one crew subprocess at a time (small internal tool).
_run_state: dict = {"process": None, "log_file": None}


# --------------------------------------------------------------------------- #
# Request bodies
# --------------------------------------------------------------------------- #
class RunAgentRequest(BaseModel):
    """Defaults preserve the pre-multi-client behavior (bare POST still works)."""

    client_id: str = "casinogurus"
    content_type: str = "long_form"
    format: str = "blog"


class ClientUpsert(BaseModel):
    id: str | None = None  # derived from display_name when omitted (POST only)
    display_name: str
    site_domain: str
    status: Literal["active", "paused", "archived"] = "active"
    profile: dict | None = None  # validated against ClientProfile when present


class FeedbackRequest(BaseModel):
    status: Literal["shortlisted", "approved", "rejected"]
    notes: str | None = None


class ContentTypeUpsert(BaseModel):
    id: str | None = None       # slug; derived from label on POST when omitted
    label: str
    sort_order: int = 0


class FormatUpsert(BaseModel):
    id: str | None = None       # slug; derived from label on POST when omitted
    content_type: str
    label: str
    description: str = ""
    enabled: bool = True
    task_variant: str = "default"
    pipeline: dict = {}
    stage_labels: list[str] = []
    sort_order: int = 0


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not slug:
        raise HTTPException(status_code=422, detail="display_name yields an empty slug")
    return slug


def _validated_profile(profile: dict) -> dict:
    try:
        return ClientProfile.model_validate(profile).model_dump()
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=f"invalid client profile: {e.errors()[:5]}")


# --------------------------------------------------------------------------- #
# Data access
# --------------------------------------------------------------------------- #
def _list_batches(client_id: str | None = None) -> list[dict]:
    where = "WHERE b.client_id = %(client_id)s" if client_id else ""
    with connection() as conn:
        rows = conn.execute(
            f"""SELECT b.id, b.batch_date, b.total_packages, b.ready_for_review_count,
                      b.needs_review_count, b.source, b.ingested_at,
                      b.client_id, b.content_type, b.format,
                      c.display_name AS client_name,
                      COUNT(p.package_id) AS package_count
               FROM batches b
               LEFT JOIN packages p ON p.batch_id = b.id
               LEFT JOIN clients c ON c.id = b.client_id
               {where}
               GROUP BY b.id, c.display_name
               ORDER BY b.ingested_at DESC, b.id DESC""",
            {"client_id": client_id},
        ).fetchall()
        return [dict(r) for r in rows]


def _merge_feedback(batch: dict) -> dict:
    """Attach the latest reviewer feedback event to each package dict so the
    viewer needs no second request. Best-effort: never fails the batch load."""
    try:
        packages = batch.get("packages") or []
        ids = [p.get("package_id") for p in packages if p.get("package_id")]
        reviews = storage.latest_reviews_for_packages(ids)
        for pkg in packages:
            fb = reviews.get(pkg.get("package_id"))
            if fb:
                pkg["feedback"] = {k: v for k, v in fb.items() if k != "package_id"}
    except Exception:
        pass
    return batch


def _get_batch(batch_id: int) -> dict | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT id, raw_json FROM batches WHERE id = %s", (batch_id,)
        ).fetchone()
    if not row:
        return None
    # raw_json is JSONB, so psycopg returns a dict already (no json.loads).
    batch = row["raw_json"]
    if isinstance(batch, dict):
        batch["id"] = row["id"]
        batch = _merge_feedback(batch)
    return batch


def _latest_batch() -> dict | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT id, raw_json FROM batches ORDER BY ingested_at DESC, id DESC LIMIT 1"
        ).fetchone()
    if not row:
        return None
    batch = row["raw_json"]
    if isinstance(batch, dict):
        batch["id"] = row["id"]
    return batch


def _image_payload(row: dict | None) -> dict | None:
    if not row:
        return None
    return {
        "package_id": row.get("package_id"),
        "status": row.get("status"),
        "image_b64": row.get("image_b64"),
        "mime_type": row.get("mime_type"),
        "alt_text": row.get("alt_text"),
        "prompt": row.get("prompt"),
        "model": row.get("model"),
        "size": row.get("size"),
        "error": row.get("error"),
        "created_at": row.get("created_at"),
    }


# --------------------------------------------------------------------------- #
# DOCX ZIP export (ported verbatim from the old server._send_zip)
# --------------------------------------------------------------------------- #
def build_batch_zip(batch: dict) -> bytes:
    from bs4 import BeautifulSoup
    import docx

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "a", zipfile.ZIP_DEFLATED, False) as zip_file:
        for idx, pkg in enumerate(batch.get("packages", [])):
            doc = docx.Document()
            title = pkg.get("topic") or pkg.get("primary_keyword") or f"Topic_{idx+1}"
            doc.add_heading(title, 0)

            doc.add_heading("Metadata", level=1)
            doc.add_paragraph(f"Primary Keyword: {pkg.get('primary_keyword', '')}")

            draft = pkg.get("draft", {})
            doc.add_paragraph(f"Meta Description: {draft.get('meta_description', '')}")

            doc.add_heading("Content", level=1)
            html_content = draft.get("body_html", "")
            if html_content:
                soup = BeautifulSoup(html_content, "html.parser")
                for element in soup.find_all(["h2", "h3", "p", "ul", "ol", "li"]):
                    if element.name == "h2":
                        doc.add_heading(element.get_text(), level=2)
                    elif element.name == "h3":
                        doc.add_heading(element.get_text(), level=3)
                    elif element.name == "p":
                        doc.add_paragraph(element.get_text())
                    elif element.name in ["ul", "ol"]:
                        pass
                    elif element.name == "li":
                        doc.add_paragraph(element.get_text(), style="List Bullet")

            flags = draft.get("verification_flags", [])
            if flags:
                doc.add_heading("Verification Flags", level=1)
                for f in flags:
                    flag_str = f.get("flag") if isinstance(f, dict) else str(f)
                    doc.add_paragraph(flag_str, style="List Bullet")

            compliance = pkg.get("compliance_scorecard", {})
            if compliance:
                doc.add_heading("Compliance Checks", level=1)
                doc.add_paragraph(f"Overall Verdict: {compliance.get('overall_verdict', 'Unknown')}")

                blocking = compliance.get("blocking_failures", [])
                if blocking:
                    doc.add_heading("Blocking Failures", level=2)
                    for b in blocking:
                        if isinstance(b, str):
                            doc.add_paragraph(b, style="List Bullet")
                        else:
                            name = b.get("check_name") or b.get("item") or b.get("check") or b.get("name") or "Unknown Check"
                            sev = b.get("severity")
                            sev_str = f" ({sev})" if sev else ""
                            doc.add_heading(f"{name}{sev_str}", level=3)
                            if b.get("violation"):
                                doc.add_paragraph(f"Violation: {b.get('violation')}")
                            if b.get("remediation"):
                                doc.add_paragraph(f"Remediation: {b.get('remediation')}")

                checks = compliance.get("checks", [])
                if checks:
                    doc.add_heading("All Checks", level=2)
                    for c in checks:
                        name = c.get("check_name") or c.get("item") or c.get("check") or c.get("name") or "Unknown Check"
                        verdict = c.get("verdict") or c.get("result") or ""
                        sev = c.get("severity")
                        sev_str = f" [{sev}]" if sev else ""
                        doc.add_paragraph(f"{name}{sev_str}: {verdict}", style="List Bullet")
                        details = c.get("offending_text") or c.get("offendingText") or c.get("violation") or c.get("details") or ""
                        if details:
                            doc.add_paragraph(f"   Details: {details}")

            doc_buffer = io.BytesIO()
            doc.save(doc_buffer)

            filename = "".join([c for c in title if c.isalpha() or c.isdigit() or c == " "]).rstrip()
            filename = filename.replace(" ", "_") + ".docx"
            zip_file.writestr(filename, doc_buffer.getvalue())

    zip_buffer.seek(0)
    return zip_buffer.read()


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
api = APIRouter(prefix="/api", dependencies=[Depends(require_user)])


@api.get("/formats")
def list_formats():
    """Enabled content-type/format catalog (cascading), for the run modal."""
    return jsonable(storage.serialisable_registry(enabled_only=True))


# --- Content-type / format master (admin CRUD) ---------------------------- #
@api.get("/registry")
def get_registry():
    """Full catalog for the management UI: all content types + all formats
    (including disabled), plus the task variants the pipeline code supports."""
    return jsonable(
        {
            "content_types": storage.list_content_types(),
            "formats": storage.list_formats(enabled_only=False),
            "task_variants": AVAILABLE_TASK_VARIANTS,
        }
    )


@api.post("/content-types", status_code=201)
def create_content_type(body: ContentTypeUpsert):
    ct_id = body.id or _slugify(body.label)
    if any(c["id"] == ct_id for c in storage.list_content_types()):
        raise HTTPException(status_code=409, detail=f"content type '{ct_id}' already exists")
    return jsonable(storage.upsert_content_type(ct_id, body.label, body.sort_order))


@api.put("/content-types/{ct_id}")
def update_content_type(ct_id: str, body: ContentTypeUpsert):
    if not any(c["id"] == ct_id for c in storage.list_content_types()):
        raise HTTPException(status_code=404, detail=f"content type '{ct_id}' not found")
    return jsonable(storage.upsert_content_type(ct_id, body.label, body.sort_order))


@api.delete("/content-types/{ct_id}", status_code=204)
def remove_content_type(ct_id: str):
    storage.delete_content_type(ct_id)  # cascades to its formats
    return Response(status_code=204)


@api.post("/formats", status_code=201)
def create_format(body: FormatUpsert):
    fmt_id = body.id or _slugify(body.label)
    if storage.get_format_row(fmt_id):
        raise HTTPException(status_code=409, detail=f"format '{fmt_id}' already exists")
    _validate_format_body(body)
    return jsonable(
        storage.upsert_format(
            fmt_id, body.content_type, body.label, body.description, body.enabled,
            body.task_variant, body.pipeline, body.stage_labels, body.sort_order,
        )
    )


@api.put("/formats/{fmt_id}")
def update_format(fmt_id: str, body: FormatUpsert):
    if not storage.get_format_row(fmt_id):
        raise HTTPException(status_code=404, detail=f"format '{fmt_id}' not found")
    _validate_format_body(body)
    return jsonable(
        storage.upsert_format(
            fmt_id, body.content_type, body.label, body.description, body.enabled,
            body.task_variant, body.pipeline, body.stage_labels, body.sort_order,
        )
    )


@api.delete("/formats/{fmt_id}", status_code=204)
def remove_format(fmt_id: str):
    storage.delete_format(fmt_id)
    return Response(status_code=204)


def _validate_format_body(body: FormatUpsert) -> None:
    if not any(c["id"] == body.content_type for c in storage.list_content_types()):
        raise HTTPException(status_code=422, detail=f"unknown content_type '{body.content_type}'")
    if body.task_variant not in AVAILABLE_TASK_VARIANTS:
        raise HTTPException(
            status_code=422,
            detail=f"task_variant '{body.task_variant}' is not implemented in the pipeline "
                   f"(available: {AVAILABLE_TASK_VARIANTS})",
        )


@api.get("/clients")
def list_clients():
    return jsonable(storage.list_clients())


@api.post("/clients", status_code=201)
def create_client(body: ClientUpsert):
    client_id = body.id or _slugify(body.display_name)
    if storage.get_client(client_id):
        raise HTTPException(status_code=409, detail=f"client '{client_id}' already exists")
    if body.profile is None:
        raise HTTPException(status_code=422, detail="profile is required when creating a client")
    profile = _validated_profile(body.profile)
    storage.upsert_client(client_id, body.display_name, body.site_domain, body.status)
    storage.insert_profile_version(client_id, profile, created_by="api")
    return jsonable(storage.get_client(client_id))


@api.get("/clients/{client_id}")
def get_client(client_id: str):
    client = storage.get_client(client_id)
    if not client:
        raise HTTPException(status_code=404, detail=f"client '{client_id}' not found")
    return jsonable(client)


@api.put("/clients/{client_id}")
def update_client(client_id: str, body: ClientUpsert):
    existing = storage.get_client(client_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"client '{client_id}' not found")
    storage.upsert_client(client_id, body.display_name, body.site_domain, body.status)
    if body.profile is not None:
        # Profiles are append-only: every edit becomes version N+1; in-flight
        # runs keep the version they pinned at kickoff.
        storage.insert_profile_version(client_id, _validated_profile(body.profile), created_by="api")
    return jsonable(storage.get_client(client_id))


@api.get("/runs")
def list_runs(client_id: str | None = Query(default=None)):
    return jsonable(storage.list_runs(client_id=client_id))


@api.post("/packages/{pid}/feedback")
def package_feedback(pid: str, body: FeedbackRequest, user: dict = Depends(require_user)):
    reviewer = (user or {}).get("email") or (user or {}).get("sub")
    try:
        row = storage.add_package_review(pid, body.status, body.notes, reviewer)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"package '{pid}' not found")
    return jsonable(row)


@api.get("/batches")
def list_batches(client_id: str | None = Query(default=None)):
    return jsonable(_list_batches(client_id))


@api.get("/latest")
def latest_batch():
    batch = _latest_batch()
    if batch is None:
        raise HTTPException(status_code=404, detail="no batches stored")
    return batch


@api.get("/batches/{batch_id}")
def get_batch(batch_id: int):
    batch = _get_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"batch {batch_id} not found")
    return batch


@api.get("/batches/{batch_id}/download")
def download_batch(batch_id: int):
    batch = _get_batch(batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail=f"batch {batch_id} not found")
    body = build_batch_zip(batch)
    batch_date = batch.get("batch_date", "download")
    return Response(
        content=body,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="batch_{batch_date}.zip"'},
    )


@api.get("/packages/{pid}/image")
def get_package_image(pid: str):
    payload = _image_payload(get_image(pid))
    if payload is None or payload.get("status") != "ok" or not payload.get("image_b64"):
        body = payload or {"package_id": pid, "status": "none"}
        return JSONResponse(status_code=404, content=jsonable(body))
    return payload


@api.post("/packages/{pid}/image")
def generate_package_image(pid: str, force: bool = Query(default=False)):
    from casinogurus_ai_content_engine___daily_5_topic_batch.images import generate_for_package

    try:
        row = generate_for_package(pid, force=force)
    except ValueError as e:  # unknown package id
        raise HTTPException(status_code=404, detail=str(e))
    payload = _image_payload(row)
    status_code = 200 if payload and payload.get("status") == "ok" else 502
    return JSONResponse(status_code=status_code, content=jsonable(payload or {"package_id": pid, "status": "error"}))


def _tee_output(process, log_file):
    try:
        for line in iter(process.stdout.readline, b""):
            sys.stdout.buffer.write(line)
            sys.stdout.flush()
            log_file.write(line.decode("utf-8", errors="replace"))
            log_file.flush()
    except Exception as e:
        print(f"Error in tee thread: {e}")
    finally:
        process.stdout.close()
        log_file.close()


@api.post("/run-agent")
def run_agent(body: RunAgentRequest | None = None):
    proc = _run_state["process"]
    if proc is not None and proc.poll() is None:
        raise HTTPException(status_code=409, detail="Agent is already running")

    body = body or RunAgentRequest()

    # Validate the requested format against the DB catalog.
    spec = storage.resolve_format_spec(body.format)
    if spec is None:
        raise HTTPException(status_code=422, detail=f"unknown format '{body.format}' (see /api/formats)")
    if not spec.enabled:
        raise HTTPException(status_code=422, detail=f"format '{body.format}' is not enabled")
    if spec.content_type != body.content_type:
        raise HTTPException(
            status_code=422,
            detail=f"format '{body.format}' belongs to content type '{spec.content_type}', not '{body.content_type}'",
        )

    # Validate the client and pin its current profile version via a runs row.
    client = storage.get_client(body.client_id)
    if not client:
        raise HTTPException(status_code=404, detail=f"client '{body.client_id}' not found")
    if client["status"] != "active":
        raise HTTPException(status_code=409, detail=f"client '{body.client_id}' is {client['status']}")
    if not client["profile_version"]:
        raise HTTPException(status_code=409, detail=f"client '{body.client_id}' has no profile yet")
    run_row = storage.create_run(body.client_id, body.content_type, body.format)

    log_file = open(LOG_PATH, "w", encoding="utf-8")
    # First log line self-describes the run so the SSE terminal can label the
    # stages and header without another request (SSE replays from file start).
    log_file.write(
        "[AGENT_RUN] "
        + json.dumps(
            {
                "run_id": str(run_row["id"]),
                "client_id": client["id"],
                "client_name": client["display_name"],
                "content_type": spec.content_type,
                "format": spec.id,
                "stage_labels": list(spec.stage_labels),
            }
        )
        + "\n"
    )
    log_file.flush()

    cmd = [sys.executable, "-u", "-m", f"{PACKAGE}.main", "run", "--run-id", str(run_row["id"])]
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    try:
        process = subprocess.Popen(
            cmd, cwd=_PROJECT_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env
        )
        threading.Thread(target=_tee_output, args=(process, log_file), daemon=True).start()
    except Exception as e:
        log_file.close()
        storage.update_run(run_row["id"], status="failed", error=f"spawn failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    _run_state.update(process=process, log_file=log_file)
    return {
        "status": "started",
        "message": "Agent execution started in background.",
        "run_id": str(run_row["id"]),
        "client_id": client["id"],
        "format": spec.id,
    }


@api.get("/agent-logs")
async def agent_logs():
    async def event_stream():
        if not os.path.exists(LOG_PATH):
            open(LOG_PATH, "w").close()
        with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as f:
            while True:
                line = f.readline()
                if line:
                    yield f"data: {json.dumps({'text': line})}\n\n"
                else:
                    proc = _run_state["process"]
                    if proc is None or proc.poll() is not None:
                        # read any remaining lines before closing
                        line = f.readline()
                        if line:
                            yield f"data: {json.dumps({'text': line})}\n\n"
                            continue
                        yield "event: close\ndata: {}\n\n"
                        break
                    await asyncio.sleep(0.5)
                    # Clear internal EOF buffer state
                    f.seek(f.tell())

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def jsonable(obj):
    """Encode datetimes etc. for JSONResponse bodies built by hand."""
    from fastapi.encoders import jsonable_encoder

    return jsonable_encoder(obj)


# --------------------------------------------------------------------------- #
# App
# --------------------------------------------------------------------------- #
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure the schema exists before serving traffic.
    init_schema()
    # Seed the content-type/format catalog from code defaults if empty.
    try:
        storage.seed_registry_defaults()
    except Exception as e:
        print(f"[startup] WARNING: could not seed content-type/format catalog: {e}")
    # Seed the default client's profile v1 if it has none yet (idempotent;
    # profile edits afterwards live only in the DB as append-only versions).
    try:
        from casinogurus_ai_content_engine___daily_5_topic_batch.profile import load_seed_client

        record = load_seed_client("casinogurus")
        storage.upsert_client(record.client_id, record.display_name, record.site_domain)
        if storage.get_client(record.client_id)["profile_version"] == 0:
            storage.insert_profile_version(record.client_id, record.profile.model_dump(), created_by="lifespan-seed")
    except Exception as e:  # seeding must never block serving
        print(f"[startup] WARNING: could not seed default client profile: {e}")
    yield


def _cors_origins() -> list[str]:
    raw = os.environ.get("FRONTEND_ORIGIN", "*")
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    if not origins:
        origins = ["*"]
    
    # Always allow these origins just in case environment variables aren't updated
    safe_defaults = [
        "https://content-agent-bice.vercel.app",
        "http://localhost:3000",
    ]
    for d in safe_defaults:
        if d not in origins:
            origins.append(d)
            
    return origins


app = FastAPI(title="NEXUS Content Engine API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,  # token-based auth; no cookies
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


app.include_router(api)
