"""
CloudSignal REST Publisher — Reference Implementation

Production-grade module for publishing MQTT messages via CloudSignal's REST API.
Suitable for any Python async backend (FastAPI, Quart, Starlette, etc.).

Features:
  - Connection-pooled singleton httpx client (thread-safe via asyncio.Lock)
  - Retry with exponential backoff for critical messages
  - Progress throttling (at most 1 publish/sec/job to avoid flooding)
  - Clean shutdown

Environment variables:
  CLOUDSIGNAL_API_KEY  — REST Publisher API key from CloudSignal dashboard (sk_xxx)
  CLOUDSIGNAL_API_URL  — Optional override (default: https://rest-publisher.cloudsignal.app)
"""

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

# =============================================================================
# Configuration
# =============================================================================

CLOUDSIGNAL_API_URL = os.getenv(
    "CLOUDSIGNAL_API_URL", "https://rest-publisher.cloudsignal.app"
)
CLOUDSIGNAL_API_KEY = os.getenv("CLOUDSIGNAL_API_KEY")  # sk_xxx format

# Replace with your app namespace (must match frontend TOPIC_ROOT)
TOPIC_ROOT = "myapp"

# =============================================================================
# Connection-pooled HTTP client (singleton)
# =============================================================================

_client: Optional[httpx.AsyncClient] = None
_client_lock = asyncio.Lock()


async def get_client() -> httpx.AsyncClient:
    """
    Get or create a shared httpx.AsyncClient.

    Uses double-checked locking to avoid race conditions when multiple
    coroutines call this concurrently on startup.
    """
    global _client
    if _client is None:
        async with _client_lock:
            if _client is None:
                _client = httpx.AsyncClient(timeout=10.0)
    return _client


# =============================================================================
# Core publish functions
# =============================================================================


async def publish(
    topic: str,
    payload: Dict[str, Any],
    qos: int = 1,
    retain: bool = False,
) -> bool:
    """
    Publish a message to CloudSignal via REST API.

    Args:
        topic:   Full MQTT topic (e.g., "myapp/{user_id}/notifications").
        payload: Message payload (JSON-serializable dict).
        qos:     MQTT Quality of Service (0=fire-and-forget, 1=at-least-once, 2=exactly-once).
        retain:  Whether the broker should retain this message for new subscribers.

    Returns:
        True on success (HTTP 200/202), False otherwise.
    """
    if not CLOUDSIGNAL_API_KEY:
        logger.warning("[CloudSignal] Missing API key, skipping publish")
        return False

    try:
        client = await get_client()

        response = await client.post(
            f"{CLOUDSIGNAL_API_URL}/v1/publish",
            headers={
                "Authorization": f"Bearer {CLOUDSIGNAL_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "topic": topic,
                "payload": payload,
                "qos": qos,
                "retain": retain,
            },
        )

        if response.status_code in (200, 202):
            logger.debug("[CloudSignal] Published to %s", topic)
            return True

        logger.warning(
            "[CloudSignal] Publish failed: %s - %s",
            response.status_code,
            response.text,
        )
        return False

    except Exception as e:
        logger.error("[CloudSignal] Publish error: %s", e)
        return False


async def publish_with_retry(
    topic: str,
    payload: Dict[str, Any],
    qos: int = 1,
    retain: bool = False,
    max_retries: int = 2,
) -> bool:
    """
    Publish with exponential backoff retry for critical messages.

    Use this for messages where delivery matters (status changes, notifications,
    transactions). Do NOT use for high-frequency progress updates — the next
    tick will carry fresh data anyway.
    """
    for attempt in range(max_retries + 1):
        if await publish(topic, payload, qos, retain):
            return True
        if attempt < max_retries:
            delay = 0.5 * (2**attempt)  # 0.5s, 1s
            logger.info(
                "[CloudSignal] Retrying %s in %.1fs (attempt %d/%d)",
                topic,
                delay,
                attempt + 1,
                max_retries,
            )
            await asyncio.sleep(delay)

    logger.error(
        "[CloudSignal] Failed to publish to %s after %d attempts",
        topic,
        max_retries + 1,
    )
    return False


# =============================================================================
# Progress throttling
# =============================================================================

# Track last publish timestamp per job to avoid flooding CloudSignal
_progress_timestamps: Dict[str, float] = {}
PROGRESS_THROTTLE_SECONDS = 1.0


def clear_progress_throttle(job_id: str) -> None:
    """Remove throttle state for a completed/failed job."""
    _progress_timestamps.pop(job_id, None)


# =============================================================================
# High-level publish functions — replace/extend with your domain messages
# =============================================================================


async def publish_job_progress(
    user_id: str,
    job_id: str,
    current: int,
    total: int,
    percentage: Optional[int] = None,
    force: bool = False,
) -> bool:
    """
    Publish job progress (throttled).

    Skips publishing if called more than once per second for the same job,
    unless `force=True` or this is the final update (current >= total).
    """
    now = time.monotonic()
    last = _progress_timestamps.get(job_id, 0.0)
    is_final = total > 0 and current >= total

    if not force and not is_final and (now - last) < PROGRESS_THROTTLE_SECONDS:
        return True  # Silently skip — not an error

    _progress_timestamps[job_id] = now

    if percentage is None:
        percentage = int(current / total * 100) if total > 0 else 0

    return await publish(
        topic=f"{TOPIC_ROOT}/{user_id}/jobs/{job_id}/progress",
        payload={
            "job_id": job_id,
            "current": current,
            "total": total,
            "percentage": percentage,
        },
    )


async def publish_job_status(
    user_id: str,
    job_id: str,
    status: str,
    file_url: Optional[str] = None,
    error: Optional[str] = None,
    total_count: Optional[int] = None,
) -> bool:
    """Publish job status change (retried — critical message)."""
    clear_progress_throttle(job_id)

    payload: Dict[str, Any] = {"job_id": job_id, "status": status}
    if file_url:
        payload["file_url"] = file_url
    if error:
        payload["error"] = error
    if total_count is not None:
        payload["total_count"] = total_count

    return await publish_with_retry(
        topic=f"{TOPIC_ROOT}/{user_id}/jobs/{job_id}/status",
        payload=payload,
    )


async def publish_transaction(
    user_id: str,
    transaction_type: str,
    amount: int,
    new_balance: int,
    description: str,
    reference_id: Optional[str] = None,
) -> bool:
    """Publish transaction/balance update (retried — critical message)."""
    payload: Dict[str, Any] = {
        "type": transaction_type,
        "amount": amount,
        "new_balance": new_balance,
        "description": description,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    if reference_id:
        payload["reference_id"] = reference_id

    return await publish_with_retry(
        topic=f"{TOPIC_ROOT}/{user_id}/transactions",
        payload=payload,
    )


async def publish_notification(
    user_id: str,
    notification_type: str,
    title: str,
    message: str,
    action_url: Optional[str] = None,
    job_id: Optional[str] = None,
) -> bool:
    """Publish user notification (retried — critical message)."""
    payload: Dict[str, Any] = {
        "type": notification_type,
        "title": title,
        "message": message,
    }
    if action_url:
        payload["action_url"] = action_url
    if job_id:
        payload["job_id"] = job_id

    return await publish_with_retry(
        topic=f"{TOPIC_ROOT}/{user_id}/notifications",
        payload=payload,
    )


# =============================================================================
# Cleanup — call on application shutdown
# =============================================================================


async def cleanup() -> None:
    """Close the shared HTTP client. Call during application shutdown."""
    global _client
    if _client:
        await _client.aclose()
        _client = None
