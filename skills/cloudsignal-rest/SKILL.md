---
name: cloudsignal-rest
description: >
  Generate a Python REST publisher module for CloudSignal serverless messaging.
  Publishes MQTT messages via HTTP without persistent connections. Includes
  connection pooling, retry with backoff, and progress throttling. Use when
  implementing server-side notifications, job progress publishing, or
  backend-to-frontend real-time messaging with CloudSignal.
disable-model-invocation: true
license: MIT
metadata:
  author: cloudsignal
  version: "1.0.0"
---

# CloudSignal REST Publisher — Python Module Generator

Generate a production-grade Python module for publishing real-time messages to CloudSignal's REST API. The generated code is suitable for serverless functions, FastAPI backends, or any Python async service — no persistent MQTT connections required.

## What You Generate

**`cloudsignal.py`** — A self-contained async module with:
- Connection-pooled singleton `httpx.AsyncClient` (thread-safe via `asyncio.Lock`)
- Core `publish()` and `publish_with_retry()` with exponential backoff
- Progress throttling (max 1 publish/sec per entity to avoid flooding)
- High-level domain-specific publish functions (customized to the user's app)
- Clean shutdown hook

## Before You Start

Ask the user for these inputs (use defaults if not provided):

| Input | Example | Default |
|-------|---------|---------|
| Topic namespace | `myapp` | App name from project |
| Message types needed | notifications, jobs, transactions | All three |
| Python framework | FastAPI, Quart, Starlette, Django (async) | FastAPI |
| Target file path | `app/services/cloudsignal.py` | Ask based on project structure |

**Important**: The topic namespace MUST match the frontend's `TOPIC_ROOT` if the user has both a frontend and backend integration.

## Generation Steps

### Step 1: Read the Reference Implementation

Read `references/cloudsignal-publisher.py` in this skill's directory. This is the canonical reference — a production-tested module extracted from a live SaaS. Use it as the base for all generated code.

### Step 2: Adapt the Topic Namespace

Replace `TOPIC_ROOT = "myapp"` with the user's chosen namespace. This constant is used in all topic paths:

```python
TOPIC_ROOT = "{user's namespace}"
```

### Step 3: Customize High-Level Publish Functions

The reference includes four domain functions. Keep, modify, or replace them based on what the user needs:

| Reference Function | Purpose | When to Keep |
|-------------------|---------|--------------|
| `publish_job_progress()` | Throttled progress updates | User has long-running jobs/tasks |
| `publish_job_status()` | Job lifecycle changes (retried) | User has jobs with start/complete/fail states |
| `publish_transaction()` | Balance/payment updates (retried) | User has financial transactions |
| `publish_notification()` | User alerts/toasts (retried) | Almost always — most apps need notifications |

For custom message types, follow the same patterns:
- **High-frequency, non-critical** (progress, typing indicators): Use `publish()` with throttling
- **Low-frequency, critical** (status changes, payments): Use `publish_with_retry()`

### Step 4: Add Framework Shutdown Hook

The module's `cleanup()` function must be called on application shutdown. Generate the appropriate integration:

**FastAPI (lifespan)**:
```python
from contextlib import asynccontextmanager
from app.services import cloudsignal

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await cloudsignal.cleanup()

app = FastAPI(lifespan=lifespan)
```

**Quart**:
```python
@app.after_serving
async def shutdown():
    await cloudsignal.cleanup()
```

**Starlette**:
```python
async def on_shutdown():
    await cloudsignal.cleanup()

app = Starlette(on_shutdown=[on_shutdown])
```

### Step 5: Write the Module

Combine the adapted namespace, customized publish functions, and framework hook into the final `cloudsignal.py`. Preserve ALL of these production patterns from the reference:

- **Singleton client with double-checked locking**: `asyncio.Lock` prevents race conditions on startup
- **Progress throttling via `_progress_timestamps`**: `time.monotonic()` for drift-free timing
- **`clear_progress_throttle()`**: Always called when an entity completes/fails to clean up tracking state
- **Retry with exponential backoff**: `0.5s * 2^attempt` — keeps retries short (0.5s, 1s)
- **Separate `publish()` and `publish_with_retry()`**: Callers choose the right one for their message criticality
- **`sk_xxx` Bearer auth**: API key passed via `Authorization: Bearer` header
- **JSON payload**: All messages sent as `application/json`

## Usage Example

After generating the module, show the user how to call it from their application code:

```python
from app.services import cloudsignal

# In an API endpoint or background task:
await cloudsignal.publish_notification(
    user_id="user_abc123",
    notification_type="export_complete",
    title="Export Ready",
    message="Your data export is ready for download.",
    action_url="/exports/download/file_xyz",
)

# For long-running jobs with progress:
for i, item in enumerate(items):
    process(item)
    await cloudsignal.publish_job_progress(
        user_id=user_id,
        job_id=job_id,
        current=i + 1,
        total=len(items),
    )

# When the job completes:
await cloudsignal.publish_job_status(
    user_id=user_id,
    job_id=job_id,
    status="completed",
    file_url=download_url,
    total_count=len(items),
)
```

## Environment Variables

Tell the user to add these to their environment (`.env`, secrets manager, etc.):

```bash
CLOUDSIGNAL_API_KEY=sk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Optional — override the default REST Publisher URL:
# CLOUDSIGNAL_API_URL=https://rest-publisher.cloudsignal.app
```

## CloudSignal Dashboard Setup

Remind the user they need:
1. A CloudSignal organization at https://dashboard.cloudsignal.app
2. A **REST Publisher API key** (`sk_xxx` format) from the API Keys section
3. ACL rules allowing publish to their topic patterns

## pip Dependency

The user needs to install httpx:

```bash
pip install httpx
```

## REST API Reference

Read `references/api-reference.md` for the full REST API endpoint documentation if the user needs custom integration beyond the generated module.
