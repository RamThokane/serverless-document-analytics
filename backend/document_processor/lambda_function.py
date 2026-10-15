"""
DocumentProcessor — triggered by the existing S3 event notification
(prefix "incoming/", suffix ".txt"). The trigger itself is unchanged.

REFERENCE VERSION showing the required changes. The original source has not been
reviewed yet; the four marked CHANGE blocks are what must be merged into it.
If your existing analytics must stay byte-for-byte identical, keep your own
counting code inside analyse_text() and keep everything else from this file.

    CHANGE 1  Derive documentId from the object key instead of generating a random one.
    CHANGE 2  UPDATE the existing PENDING item (UpdateItem upsert) instead of PutItem,
              preserving fileName / uploadedAt written by DocumentApi.
    CHANGE 3  Re-check the 1 MB limit before reading the object.
    CHANGE 4  Record FAILED status + errorMessage instead of failing silently.

Environment variables:
    TABLE_NAME      DocumentAnalyticsV3
    TABLE_KEY       partition key attribute name (default "documentId")
    MAX_FILE_BYTES  default 1048576
"""

import logging
import os
import re
import uuid
from collections import Counter
from datetime import datetime, timezone
from urllib.parse import unquote_plus

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TABLE_NAME = os.environ.get("TABLE_NAME", "DocumentAnalyticsV3")
TABLE_KEY = os.environ.get("TABLE_KEY", "documentId")
MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", str(1024 * 1024)))
TOP_KEYWORDS = 10

s3 = boto3.client("s3")
table = boto3.resource("dynamodb").Table(TABLE_NAME)

# Keys created by DocumentApi look like incoming/<uuid4>.txt
API_KEY_PATTERN = re.compile(
    r"^incoming/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.txt$"
)


class PermanentProcessingError(Exception):
    """A problem with the file itself; retrying will not help."""


def lambda_handler(event, context):
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        # S3 event keys are URL-encoded ("my+file.txt" -> "my file.txt").
        key = unquote_plus(record["s3"]["object"]["key"])
        size = record["s3"]["object"].get("size")
        event_time = record.get("eventTime") or utc_now_iso()
        process_object(bucket, key, size, event_time)
    return {"status": "ok"}


def process_object(bucket, key, size, event_time):
    document_id = document_id_for(bucket, key)  # CHANGE 1
    logger.info("Processing s3://%s/%s as documentId=%s", bucket, key, document_id)

    try:
        # CHANGE 3: never trust that only the API uploads to this bucket.
        if size is not None and size > MAX_FILE_BYTES:
            raise PermanentProcessingError(f"File is {size} bytes; the limit is {MAX_FILE_BYTES} bytes.")

        obj = s3.get_object(Bucket=bucket, Key=key)
        data = obj["Body"].read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise PermanentProcessingError(f"File exceeds the {MAX_FILE_BYTES} byte limit.")

        text = data.decode("utf-8-sig", errors="replace")
        analytics = analyse_text(text)
        mark_completed(document_id, key, len(data), event_time, analytics)  # CHANGE 2
        logger.info("Completed documentId=%s words=%s", document_id, analytics["wordCount"])

    except PermanentProcessingError as err:
        mark_failed(document_id, key, event_time, str(err))  # CHANGE 4
        logger.warning("Rejected documentId=%s: %s", document_id, err)

    except Exception as err:
        # Record the failure, then re-raise so Lambda's async retries still happen.
        # A successful retry overwrites status back to COMPLETED.
        mark_failed(document_id, key, event_time, "Processing error: " + type(err).__name__)
        raise


# ---------------------------------------------------------------------------
# CHANGE 1 — stable document ID
# ---------------------------------------------------------------------------

def document_id_for(bucket, key):
    """
    Uploads made through DocumentApi carry their ID in the key: incoming/<id>.txt.
    For anything else (e.g. a manual console upload) derive a deterministic UUID
    from the bucket+key, so S3's at-least-once event delivery or a re-upload of the
    same key updates one record instead of creating duplicates.
    """
    match = API_KEY_PATTERN.match(key)
    if match:
        return match.group(1)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"s3://{bucket}/{key}"))


# ---------------------------------------------------------------------------
# CHANGE 2 / 4 — update the record in place
# ---------------------------------------------------------------------------

def mark_completed(document_id, key, size, event_time, analytics):
    """
    UpdateItem creates the item if it does not exist and otherwise modifies only the
    listed attributes. fileName/uploadedAt use if_not_exists so values written by
    DocumentApi (original name, real upload time) are never overwritten.
    """
    table.update_item(
        Key={TABLE_KEY: document_id},
        UpdateExpression=(
            "SET #status = :status, wordCount = :words, characterCount = :chars, "
            "paragraphCount = :paras, topKeywords = :keywords, processedAt = :now, "
            "s3Key = :key, fileSize = :size, "
            "fileName = if_not_exists(fileName, :fallbackName), "
            "uploadedAt = if_not_exists(uploadedAt, :eventTime) "
            "REMOVE errorMessage, expiresAt"
        ),
        ExpressionAttributeNames={"#status": "status"},  # "status" is a DynamoDB reserved word
        ExpressionAttributeValues={
            ":status": "COMPLETED",
            ":words": analytics["wordCount"],
            ":chars": analytics["characterCount"],
            ":paras": analytics["paragraphCount"],
            ":keywords": analytics["topKeywords"],
            ":now": utc_now_iso(),
            ":key": key,
            ":size": size,
            ":fallbackName": key.rsplit("/", 1)[-1],
            ":eventTime": event_time,
        },
    )


def mark_failed(document_id, key, event_time, message):
    table.update_item(
        Key={TABLE_KEY: document_id},
        UpdateExpression=(
            "SET #status = :status, errorMessage = :msg, processedAt = :now, s3Key = :key, "
            "fileName = if_not_exists(fileName, :fallbackName), "
            "uploadedAt = if_not_exists(uploadedAt, :eventTime) "
            "REMOVE wordCount, characterCount, paragraphCount, topKeywords, expiresAt"
        ),
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={
            ":status": "FAILED",
            ":msg": message[:500],
            ":now": utc_now_iso(),
            ":key": key,
            ":fallbackName": key.rsplit("/", 1)[-1],
            ":eventTime": event_time,
        },
    )


# ---------------------------------------------------------------------------
# Analytics — replace the body with your existing logic if results must match
# ---------------------------------------------------------------------------

STOP_WORDS = frozenset("""
a about above after again against all am an and any are as at be because been before being
below between both but by can could did do does doing down during each few for from further
had has have having he her here hers herself him himself his how i if in into is it its itself
just me more most my myself no nor not now of off on once only or other our ours ourselves out
over own same she should so some such than that the their theirs them themselves then there
these they this those through to too under until up very was we were what when where which
while who whom why will with would you your yours yourself yourselves also may might must shall
""".split())


def analyse_text(text):
    words = text.split()
    paragraphs = [p for p in re.split(r"\n\s*\n", text.strip()) if p.strip()]
    tokens = re.findall(r"[a-z][a-z'-]*", text.lower())
    counts = Counter(t for t in tokens if len(t) > 2 and t not in STOP_WORDS)
    return {
        "wordCount": len(words),
        "characterCount": len(text),
        "paragraphCount": len(paragraphs),
        # List of maps: stored natively in DynamoDB and returned unchanged by DocumentApi.
        "topKeywords": [{"word": w, "count": c} for w, c in counts.most_common(TOP_KEYWORDS)],
    }


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
