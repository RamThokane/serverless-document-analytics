"""
DocumentApi — API Lambda behind an API Gateway HTTP API (payload format 2.0).

Routes (must match app.js):
    POST /uploads                  -> create a PENDING record + presigned S3 PUT URL
    GET  /documents                -> list all document records
    GET  /documents/{documentId}   -> one document record, or JSON 404

Stable document ID flow:
    1. POST /uploads generates documentId (UUID4) and the key incoming/<documentId>.txt.
    2. It writes a PENDING item (fileName, uploadedAt, s3Key, fileSize) BEFORE returning the URL.
    3. The browser PUTs the file to that key; the existing S3 event (incoming/ + .txt)
       triggers DocumentProcessor.
    4. DocumentProcessor parses documentId back out of the key and UPDATES the same item
       (status COMPLETED/FAILED + analytics). No new random ID, no second item.

CORS is configured on the HTTP API itself (built-in CORS), not in this code.

Environment variables:
    BUCKET_NAME      serverless-doc-analytics-ram-2026-73921
    TABLE_NAME       DocumentAnalyticsV3
    TABLE_KEY        partition key attribute name (default "documentId")
    UPLOAD_PREFIX    default "incoming/"
    MAX_FILE_BYTES   default 1048576 (1 MB)
    URL_EXPIRES_SECONDS  default 300
    PENDING_TTL_SECONDS  default 86400 (only used if DynamoDB TTL is enabled on "expiresAt")
"""

import base64
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

BUCKET_NAME = os.environ.get("BUCKET_NAME", "serverless-doc-analytics-ram-2026-73921")
TABLE_NAME = os.environ.get("TABLE_NAME", "DocumentAnalyticsV3")
TABLE_KEY = os.environ.get("TABLE_KEY", "documentId")
UPLOAD_PREFIX = os.environ.get("UPLOAD_PREFIX", "incoming/")
MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", str(1024 * 1024)))
URL_EXPIRES_SECONDS = int(os.environ.get("URL_EXPIRES_SECONDS", "300"))
PENDING_TTL_SECONDS = int(os.environ.get("PENDING_TTL_SECONDS", "86400"))

ALLOWED_CONTENT_TYPE = "text/plain"
MAX_FILENAME_LENGTH = 255

# Regional endpoint + SigV4 so the presigned URL works in ap-southeast-2.
s3 = boto3.client(
    "s3",
    region_name=os.environ.get("AWS_REGION", "ap-southeast-2"),
    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
)
table = boto3.resource("dynamodb").Table(TABLE_NAME)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def lambda_handler(event, context):
    route = event.get("routeKey", "")
    try:
        if route == "POST /uploads":
            return create_upload(event)
        if route == "GET /documents":
            return list_documents()
        if route == "GET /documents/{documentId}":
            document_id = (event.get("pathParameters") or {}).get("documentId", "")
            return get_document(document_id)
        return response(404, {"message": "Route not found."})
    except ClientError:
        logger.exception("AWS call failed for route %s", route)
        return response(502, {"message": "A storage service request failed. Please try again."})
    except Exception:
        logger.exception("Unhandled error for route %s", route)
        return response(500, {"message": "Internal server error."})


# ---------------------------------------------------------------------------
# POST /uploads
# ---------------------------------------------------------------------------

def create_upload(event):
    body, error = parse_json_body(event)
    if error:
        return response(400, {"message": error})

    file_name, error = validate_file_name(body.get("fileName"))
    if error:
        return response(400, {"message": error})

    content_type = body.get("contentType")
    if not isinstance(content_type, str) or content_type.strip().lower() != ALLOWED_CONTENT_TYPE:
        return response(400, {"message": "Only text/plain uploads are supported."})

    file_size = body.get("fileSize")
    # bool is a subclass of int in Python, so exclude it explicitly.
    if not isinstance(file_size, int) or isinstance(file_size, bool):
        return response(400, {"message": "fileSize must be an integer number of bytes."})
    if file_size <= 0:
        return response(400, {"message": "The file is empty."})
    if file_size > MAX_FILE_BYTES:
        return response(400, {"message": f"The file exceeds the {MAX_FILE_BYTES} byte limit."})

    # The server, not the client, decides the ID and the object key.
    document_id = str(uuid.uuid4())
    key = f"{UPLOAD_PREFIX}{document_id}.txt"
    now = utc_now_iso()

    # 1) Record the upload as PENDING first, so polling never sees a gap and the
    #    original file name / upload time are preserved for DocumentProcessor.
    table.put_item(
        Item={
            TABLE_KEY: document_id,
            "fileName": file_name,
            "s3Key": key,
            "contentType": ALLOWED_CONTENT_TYPE,
            "fileSize": file_size,
            "status": "PENDING",
            "uploadedAt": now,
            # Removed by DocumentProcessor on completion. If TTL is enabled on this
            # attribute, abandoned uploads (URL never used) are cleaned up automatically.
            "expiresAt": int(time.time()) + PENDING_TTL_SECONDS,
        },
        # A UUID4 collision is practically impossible; this guard makes overwrite impossible.
        ConditionExpression="attribute_not_exists(#pk)",
        ExpressionAttributeNames={"#pk": TABLE_KEY},
    )

    # 2) Presign a PUT for exactly this key. ContentType is part of the signature,
    #    so the browser must send "Content-Type: text/plain" (app.js does).
    #    ContentLength is signed too, so S3 rejects a body whose size differs from
    #    the declared fileSize (DocumentProcessor still re-checks the size).
    upload_url = s3.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": BUCKET_NAME,
            "Key": key,
            "ContentType": ALLOWED_CONTENT_TYPE,
            "ContentLength": file_size,
        },
        ExpiresIn=URL_EXPIRES_SECONDS,
        HttpMethod="PUT",
    )

    logger.info("Created upload documentId=%s key=%s size=%s", document_id, key, file_size)
    return response(200, {
        "documentId": document_id,
        "uploadUrl": upload_url,
        "key": key,
        "expiresIn": URL_EXPIRES_SECONDS,
    })


FILENAME_FORBIDDEN = re.compile(r"[\x00-\x1f\x7f]")


def validate_file_name(raw):
    """Return (display_name, error). The name is only stored for display — never used as a path."""
    if not isinstance(raw, str) or not raw.strip():
        return None, "fileName is required."
    # Keep only the last path segment in case a client sends "C:\\x\\a.txt" or "../a.txt".
    name = re.split(r"[\\/]", raw.strip())[-1].strip()
    if not name or name in (".", ".."):
        return None, "fileName is invalid."
    if len(name) > MAX_FILENAME_LENGTH:
        return None, f"fileName must be at most {MAX_FILENAME_LENGTH} characters."
    if FILENAME_FORBIDDEN.search(name):
        return None, "fileName contains control characters."
    if not name.lower().endswith(".txt") or len(name) == 4:
        return None, "Only .txt files are supported."
    return name, None


def parse_json_body(event):
    raw = event.get("body")
    if raw is None:
        return None, "Request body is required."
    if event.get("isBase64Encoded"):
        try:
            raw = base64.b64decode(raw).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None, "Request body is not valid UTF-8."
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        return None, "Request body must be valid JSON."
    if not isinstance(body, dict):
        return None, "Request body must be a JSON object."
    return body, None


# ---------------------------------------------------------------------------
# GET /documents and GET /documents/{documentId}
# ---------------------------------------------------------------------------

def list_documents():
    items = []
    scan_kwargs = {}
    while True:  # Scan returns at most 1 MB per page, so follow LastEvaluatedKey.
        page = table.scan(**scan_kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            break
        scan_kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]

    documents = [to_api_document(item, include_keywords=False) for item in items]
    documents = [d for d in documents if d is not None]
    documents.sort(key=lambda d: d.get("uploadedAt") or "", reverse=True)
    return response(200, {"items": documents, "count": len(documents)})


def get_document(document_id):
    if not document_id or len(document_id) > 256:
        return response(400, {"message": "A valid documentId is required."})
    result = table.get_item(Key={TABLE_KEY: document_id}, ConsistentRead=True)
    item = result.get("Item")
    if not item:
        return response(404, {"message": "Document not found."})
    return response(200, to_api_document(item, include_keywords=True))


def first_present(item, names):
    for name in names:
        value = item.get(name)
        if value is not None and value != "":
            return value
    return None


def to_api_document(item, include_keywords):
    """
    Map a DynamoDB item to the field names app.js reads.
    New records use these names directly; the alias lists also cover the
    attribute names written by the ORIGINAL DocumentProcessor — confirm them
    against a real legacy item before relying on it.
    """
    item = to_json_compatible(item)
    document_id = item.get(TABLE_KEY)
    if document_id is None:
        return None

    s3_key = first_present(item, ["s3Key", "objectKey", "key"])
    word_count = first_present(item, ["wordCount", "word_count"])
    status = first_present(item, ["status"])
    if status is None:
        # Legacy records were only written after successful processing.
        status = "COMPLETED" if word_count is not None else "UNKNOWN"

    doc = {
        "documentId": str(document_id),
        "fileName": first_present(item, ["fileName", "filename", "originalFileName"])
                    or (s3_key.rsplit("/", 1)[-1] if s3_key else str(document_id)),
        "s3Key": s3_key,
        "status": str(status).upper(),
        "uploadedAt": first_present(item, ["uploadedAt", "uploadDate", "createdAt", "timestamp"]),
        "processedAt": first_present(item, ["processedAt", "completedAt"]),
        "fileSize": first_present(item, ["fileSize", "sizeBytes", "size"]),
        "wordCount": word_count,
        "characterCount": first_present(item, ["characterCount", "charCount", "character_count"]),
        "paragraphCount": first_present(item, ["paragraphCount", "paragraph_count"]),
        "errorMessage": first_present(item, ["errorMessage"]),
    }
    if include_keywords:
        doc["topKeywords"] = normalise_keywords(
            first_present(item, ["topKeywords", "top_keywords", "keywords"]))
    return doc


def normalise_keywords(raw):
    """Always return [{"word": str, "count": int}], highest count first."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return []
    pairs = []
    if isinstance(raw, dict):
        pairs = list(raw.items())
    elif isinstance(raw, list):
        for entry in raw:
            if isinstance(entry, dict):
                pairs.append((entry.get("word") or entry.get("keyword"),
                              entry.get("count", entry.get("frequency"))))
            elif isinstance(entry, (list, tuple)) and len(entry) == 2:
                pairs.append((entry[0], entry[1]))
    result = [
        {"word": str(word), "count": count}
        for word, count in pairs
        if word and isinstance(count, (int, float)) and not isinstance(count, bool)
    ]
    result.sort(key=lambda k: k["count"], reverse=True)
    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def to_json_compatible(value):
    """Recursively convert DynamoDB Decimals (and sets) into plain JSON types."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: to_json_compatible(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json_compatible(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return sorted(to_json_compatible(v) for v in value)
    return value


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
        },
        "body": json.dumps(to_json_compatible(body)),
    }
