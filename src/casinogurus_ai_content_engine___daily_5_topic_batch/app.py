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
    GET  /api/batches
    GET  /api/batches/{id}
    GET  /api/batches/{id}/download          -> docx ZIP
    GET  /api/latest
    GET  /api/packages/{pid}/image
    POST /api/packages/{pid}/image[?force=1]
    POST /api/run-agent
    GET  /api/agent-logs                      -> SSE
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import subprocess
import sys
import threading
import zipfile
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from casinogurus_ai_content_engine___daily_5_topic_batch.auth import require_user
from casinogurus_ai_content_engine___daily_5_topic_batch.db import (
    _PROJECT_ROOT,
    connection,
    init_schema,
)
from casinogurus_ai_content_engine___daily_5_topic_batch.storage import get_image

PACKAGE = "casinogurus_ai_content_engine___daily_5_topic_batch"
LOG_PATH = os.path.join(_PROJECT_ROOT, "agent.log")

# Single-run guard: at most one crew subprocess at a time (small internal tool).
_run_state: dict = {"process": None, "log_file": None}


# --------------------------------------------------------------------------- #
# Data access
# --------------------------------------------------------------------------- #
def _list_batches() -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            """SELECT b.id, b.batch_date, b.total_packages, b.ready_for_review_count,
                      b.needs_review_count, b.source, b.ingested_at,
                      COUNT(p.package_id) AS package_count
               FROM batches b
               LEFT JOIN packages p ON p.batch_id = b.id
               GROUP BY b.id
               ORDER BY b.ingested_at DESC, b.id DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


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


@api.get("/batches")
def list_batches():
    return _list_batches()


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
def run_agent():
    proc = _run_state["process"]
    if proc is not None and proc.poll() is None:
        raise HTTPException(status_code=409, detail="Agent is already running")

    log_file = open(LOG_PATH, "w", encoding="utf-8")
    cmd = [sys.executable, "-u", "-m", f"{PACKAGE}.main", "run"]
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
        raise HTTPException(status_code=500, detail=str(e))
    _run_state.update(process=process, log_file=log_file)
    return {"status": "started", "message": "Agent execution started in background."}


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


app = FastAPI(title="CasinoGurus Content Engine API", lifespan=lifespan)

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
