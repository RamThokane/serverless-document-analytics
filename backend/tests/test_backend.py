"""
Offline tests for DocumentApi and DocumentProcessor.

No AWS calls are made: DynamoDB and S3 reads are replaced by in-memory fakes,
and presigned URLs are generated locally by botocore with dummy credentials.

Run from the backend/ folder (requires boto3 installed locally):
    python -m unittest discover -s tests -v
"""

import importlib.util
import io
import json
import os
import re
import unittest
from decimal import Decimal
from pathlib import Path
from urllib.parse import parse_qs, unquote_plus, urlparse

# Dummy credentials so botocore can sign URLs offline. Never real keys.
os.environ.update({
    "AWS_ACCESS_KEY_ID": "testing",
    "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_DEFAULT_REGION": "ap-southeast-2",
    "AWS_REGION": "ap-southeast-2",
})

ROOT = Path(__file__).resolve().parent.parent


def load(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = load("document_api", "document_api/lambda_function.py")
processor = load("document_processor", "document_processor/lambda_function.py")


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

def to_dynamo(value):
    """Mimic boto3: numbers come back from DynamoDB as Decimal."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, dict):
        return {k: to_dynamo(v) for k, v in value.items()}
    if isinstance(value, list):
        return [to_dynamo(v) for v in value]
    return value


class ConditionalCheckFailed(Exception):
    pass


class FakeTable:
    """Supports exactly the DynamoDB calls and expression forms used by the two Lambdas."""

    def __init__(self, key_name="documentId", page_size=2):
        self.key_name = key_name
        self.items = {}
        self.page_size = page_size  # small, to exercise Scan pagination

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeNames=None):
        key = Item[self.key_name]
        if ConditionExpression == "attribute_not_exists(#pk)" and key in self.items:
            raise ConditionalCheckFailed()
        self.items[key] = to_dynamo(dict(Item))

    def get_item(self, Key, ConsistentRead=False):
        item = self.items.get(Key[self.key_name])
        return {"Item": dict(item)} if item else {}

    def scan(self, ExclusiveStartKey=None):
        keys = sorted(self.items)
        start = keys.index(ExclusiveStartKey[self.key_name]) + 1 if ExclusiveStartKey else 0
        chunk = keys[start:start + self.page_size]
        page = {"Items": [dict(self.items[k]) for k in chunk]}
        if start + self.page_size < len(keys):
            page["LastEvaluatedKey"] = {self.key_name: chunk[-1]}
        return page

    def update_item(self, Key, UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.items.setdefault(Key[self.key_name], {self.key_name: Key[self.key_name]})
        names, values = ExpressionAttributeNames, ExpressionAttributeValues
        set_part, _, remove_part = UpdateExpression.partition(" REMOVE ")
        set_part = set_part.removeprefix("SET ").strip()
        for lhs, rhs in re.findall(r"([#\w]+)\s*=\s*(if_not_exists\([^)]*\)|:\w+)", set_part):
            attr = names.get(lhs, lhs)
            fn = re.match(r"if_not_exists\((\w+),\s*(:\w+)\)", rhs)
            if fn:
                if fn.group(1) not in item:
                    item[attr] = to_dynamo(values[fn.group(2)])
            else:
                item[attr] = to_dynamo(values[rhs])
        for attr in filter(None, (a.strip() for a in remove_part.split(","))):
            item.pop(names.get(attr, attr), None)


class FakeS3Reader:
    def __init__(self, objects):
        self.objects = objects

    def get_object(self, Bucket, Key):
        return {"Body": io.BytesIO(self.objects[Key])}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def http_event(route, body=None, path_params=None):
    return {
        "routeKey": route,
        "body": json.dumps(body) if body is not None else None,
        "isBase64Encoded": False,
        "pathParameters": path_params or {},
    }


def call(event):
    result = api.lambda_handler(event, None)
    return result["statusCode"], json.loads(result["body"])


def s3_event(key, size):
    return {"Records": [{
        "eventTime": "2026-10-14T01:00:00.000Z",
        "s3": {"bucket": {"name": api.BUCKET_NAME}, "object": {"key": key, "size": size}},
    }]}


VALID_UPLOAD = {"fileName": "Project Notes.txt", "contentType": "text/plain", "fileSize": 120}
SAMPLE_TEXT = b"Cloud computing on AWS.\n\nLambda functions process cloud documents.\nCloud storage.\n"


class BackendTestCase(unittest.TestCase):
    def setUp(self):
        self.table = FakeTable()
        api.table = self.table
        processor.table = self.table
        self.objects = {}
        processor.s3 = FakeS3Reader(self.objects)

    def upload(self, body=VALID_UPLOAD):
        return call(http_event("POST /uploads", body))

    def run_processor(self, key, content):
        self.objects[unquote_plus(key)] = content  # S3 stores the decoded key
        processor.lambda_handler(s3_event(key, len(content)), None)


# ---------------------------------------------------------------------------
# POST /uploads
# ---------------------------------------------------------------------------

class UploadTests(BackendTestCase):
    def test_creates_pending_record_and_presigned_put(self):
        status, body = self.upload()
        self.assertEqual(status, 200)
        doc_id = body["documentId"]
        self.assertEqual(body["key"], f"incoming/{doc_id}.txt")
        self.assertRegex(body["key"], processor.API_KEY_PATTERN)

        item = self.table.items[doc_id]
        self.assertEqual(item["status"], "PENDING")
        self.assertEqual(item["fileName"], "Project Notes.txt")
        self.assertIn("uploadedAt", item)

        url = urlparse(body["uploadUrl"])
        query = parse_qs(url.query)
        self.assertTrue(url.hostname.startswith(api.BUCKET_NAME + ".s3."))
        self.assertEqual(url.path, "/" + body["key"])
        signed = query["X-Amz-SignedHeaders"][0].split(";")
        self.assertIn("content-type", signed)
        self.assertEqual(query["X-Amz-Expires"], ["300"])
        self.assertIn("ap-southeast-2", query["X-Amz-Credential"][0])

    def test_ids_are_unique(self):
        ids = {self.upload()[1]["documentId"] for _ in range(5)}
        self.assertEqual(len(ids), 5)

    def test_rejections(self):
        cases = {
            "pdf": dict(VALID_UPLOAD, fileName="a.pdf"),
            "bare extension": dict(VALID_UPLOAD, fileName=".txt"),
            "missing name": dict(VALID_UPLOAD, fileName=""),
            "control chars": dict(VALID_UPLOAD, fileName="a\x00b.txt"),
            "too long": dict(VALID_UPLOAD, fileName="a" * 300 + ".txt"),
            "wrong type": dict(VALID_UPLOAD, contentType="application/pdf"),
            "too large": dict(VALID_UPLOAD, fileSize=1024 * 1024 + 1),
            "empty": dict(VALID_UPLOAD, fileSize=0),
            "string size": dict(VALID_UPLOAD, fileSize="100"),
            "bool size": dict(VALID_UPLOAD, fileSize=True),
        }
        for label, body in cases.items():
            with self.subTest(label):
                status, payload = self.upload(body)
                self.assertEqual(status, 400)
                self.assertIn("message", payload)
        self.assertEqual(self.table.items, {})  # nothing written for rejected requests

    def test_invalid_json(self):
        event = http_event("POST /uploads")
        event["body"] = "{not json"
        self.assertEqual(call(event)[0], 400)

    def test_path_in_filename_is_stripped(self):
        status, body = self.upload(dict(VALID_UPLOAD, fileName="..\\..\\secret\\notes.txt"))
        self.assertEqual(status, 200)
        self.assertEqual(self.table.items[body["documentId"]]["fileName"], "notes.txt")

    def test_exact_size_limit_allowed(self):
        self.assertEqual(self.upload(dict(VALID_UPLOAD, fileSize=1024 * 1024))[0], 200)


# ---------------------------------------------------------------------------
# GET routes + serialisation
# ---------------------------------------------------------------------------

class ReadTests(BackendTestCase):
    def test_get_missing_returns_json_404(self):
        status, body = call(http_event("GET /documents/{documentId}", path_params={"documentId": "nope"}))
        self.assertEqual(status, 404)
        self.assertEqual(body, {"message": "Document not found."})

    def test_unknown_route(self):
        self.assertEqual(call(http_event("DELETE /documents"))[0], 404)

    def test_list_paginates_and_serialises_decimals(self):
        for _ in range(5):  # page_size=2 -> three Scan pages
            self.upload()
        status, body = call(http_event("GET /documents"))
        self.assertEqual(status, 200)
        self.assertEqual(body["count"], 5)
        self.assertEqual(len(body["items"]), 5)
        first = body["items"][0]
        self.assertIsInstance(first["fileSize"], int)  # Decimal -> plain JSON number
        self.assertNotIn("topKeywords", first)          # list stays light

    def test_legacy_record_without_status(self):
        self.table.items["legacy-1"] = to_dynamo({
            "documentId": "legacy-1", "fileName": "old.txt", "wordCount": 10,
            "topKeywords": {"alpha": 3, "beta": 5},
        })
        _, body = call(http_event("GET /documents/{documentId}", path_params={"documentId": "legacy-1"}))
        self.assertEqual(body["status"], "COMPLETED")
        self.assertEqual(body["topKeywords"], [{"word": "beta", "count": 5}, {"word": "alpha", "count": 3}])

    def test_decimal_float(self):
        self.assertEqual(api.to_json_compatible(Decimal("2.5")), 2.5)
        self.assertEqual(api.to_json_compatible(Decimal("3")), 3)


# ---------------------------------------------------------------------------
# End-to-end: upload -> S3 event -> processor -> GET
# ---------------------------------------------------------------------------

class FlowTests(BackendTestCase):
    def get(self, doc_id):
        return call(http_event("GET /documents/{documentId}", path_params={"documentId": doc_id}))

    def test_stable_id_flow(self):
        _, upload = self.upload()
        doc_id, key = upload["documentId"], upload["key"]

        status, pending = self.get(doc_id)
        self.assertEqual((status, pending["status"]), (200, "PENDING"))

        self.run_processor(key, SAMPLE_TEXT)

        status, done = self.get(doc_id)
        self.assertEqual(status, 200)
        self.assertEqual(done["documentId"], doc_id)
        self.assertEqual(done["status"], "COMPLETED")
        self.assertEqual(done["fileName"], "Project Notes.txt")          # preserved
        self.assertEqual(done["uploadedAt"], pending["uploadedAt"])     # preserved
        self.assertEqual(done["wordCount"], 11)
        self.assertEqual(done["paragraphCount"], 2)
        self.assertEqual(done["topKeywords"][0], {"word": "cloud", "count": 3})
        self.assertNotIn("expiresAt", self.table.items[doc_id])
        self.assertEqual(len(self.table.items), 1)                       # no duplicate

    def test_duplicate_s3_event_is_idempotent(self):
        _, upload = self.upload()
        self.run_processor(upload["key"], SAMPLE_TEXT)
        self.run_processor(upload["key"], SAMPLE_TEXT)
        self.assertEqual(len(self.table.items), 1)

    def test_oversized_object_marked_failed(self):
        _, upload = self.upload()
        self.run_processor(upload["key"], b"x" * (1024 * 1024 + 1))
        _, doc = self.get(upload["documentId"])
        self.assertEqual(doc["status"], "FAILED")
        self.assertIn("limit", doc["errorMessage"])
        self.assertEqual(doc["fileName"], "Project Notes.txt")

    def test_unexpected_error_marks_failed_and_reraises(self):
        _, upload = self.upload()
        processor.s3 = FakeS3Reader({})  # get_object -> KeyError
        with self.assertRaises(KeyError):
            processor.lambda_handler(s3_event(upload["key"], 10), None)
        _, doc = self.get(upload["documentId"])
        self.assertEqual(doc["status"], "FAILED")

    def test_retry_after_failure_recovers(self):
        _, upload = self.upload()
        processor.mark_failed(upload["documentId"], upload["key"], "t", "temporary")
        self.run_processor(upload["key"], SAMPLE_TEXT)
        _, doc = self.get(upload["documentId"])
        self.assertEqual(doc["status"], "COMPLETED")
        self.assertIsNone(doc["errorMessage"])

    def test_manual_console_upload_gets_deterministic_id(self):
        key = "incoming/My+Report.txt"  # URL-encoded as S3 delivers it
        self.run_processor(key, SAMPLE_TEXT)
        self.run_processor(key, SAMPLE_TEXT)
        self.assertEqual(len(self.table.items), 1)
        (item,) = self.table.items.values()
        self.assertEqual(item["fileName"], "My Report.txt")
        self.assertEqual(item["status"], "COMPLETED")


if __name__ == "__main__":
    unittest.main()
