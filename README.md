# Serverless Document Processing and Analytics Platform on AWS — Frontend

A static HTML/CSS/vanilla-JavaScript dashboard for uploading TXT documents to Amazon S3 and
viewing the analytics produced by the `DocumentProcessor` Lambda function.

No frameworks, no build step, and no AWS credentials in the browser.

## Current status

| Part | Status |
|------|--------|
| S3 bucket `serverless-doc-analytics-ram-2026-73921` (ap-southeast-2) | Exists |
| S3 event (`incoming/` + `.txt`) → `DocumentProcessor` Lambda | Exists and tested |
| DynamoDB table `DocumentAnalyticsV3` | Exists |
| Frontend (this folder) | Built; runs locally |
| **API Gateway HTTP API + API Lambda** | **Not built yet — required before the dashboard shows any data** |

Until `apiBaseUrl` is set in `config.js`, the dashboard shows an "API not configured"
message. It never shows sample or invented data.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure: sidebar, top bar, and the Overview, Upload, Documents, Details and Setup views |
| `style.css` | Layout, components and responsive rules (sidebar becomes a drawer below 820 px) |
| `config.js` | The only file to edit: API base URL, upload rules, polling settings |
| `app.js` | API layer, data normalisation, file validation, UI rendering and routing |

### How `app.js` is organised

1. **Config & utilities**: reads `window.APP_CONFIG`, plus a small `el()` DOM builder that uses `textContent` everywhere, so file names cannot inject HTML.
2. **`Api`**: every network call is here (`requestUploadUrl`, `uploadToS3`, `listDocuments`, `getDocument`), with timeouts and readable error messages.
3. **`normaliseDocument`**: maps API/DynamoDB field names into one shape. It accepts common naming variants such as `wordCount`/`word_count`, but it never fills in missing values.
4. **`validateFile`**: checks extension, MIME type, empty files and the 1 MB limit.
5. **`Ui`**: toasts, loading, empty, error and "not configured" states.
6. **Views**: Overview, Documents (search/filter/sort), Details (metrics + keyword chart), Upload (drag and drop + progress + status polling), Setup.
7. **Router**: hash routes (`#/dashboard`, `#/upload`, `#/documents`, `#/documents/<id>`, `#/setup`).

## Running locally

Any static file server works. From this folder:

```bash
# Python 3
python -m http.server 8080

# or Node.js
npx serve .
```

Then open http://localhost:8080.

Opening `index.html` directly (`file://`) also renders, but API calls need a real origin for
CORS, so use a local server.

## End-to-end flow

```
Browser ──POST /uploads──▶ API Gateway ──▶ API Lambda ──(signs URL)──┐
   ◀──── { uploadUrl, documentId } ─────────────────────────────────┘
Browser ──PUT file (presigned URL)──▶ S3  incoming/<documentId>.txt
                                        │ S3 event
                                        ▼
                               DocumentProcessor Lambda ──▶ DynamoDB DocumentAnalyticsV3
Browser ──GET /documents, /documents/{id}──▶ API Gateway ──▶ API Lambda ──▶ DynamoDB
```

## API still to build

Create one **API Gateway HTTP API** in `ap-southeast-2` with a separate **API Lambda**
(do not reuse `DocumentProcessor`). The frontend expects the following contract.

### `POST /uploads`

Request body:

```json
{ "fileName": "notes.txt", "contentType": "text/plain", "fileSize": 12345 }
```

The API Lambda must:

- Reject anything that is not `.txt`, not `text/plain`, or larger than 1 MB (**backend validation is required**; the browser checks can be bypassed).
- Generate its own `documentId` (for example a UUID) and object key `incoming/<documentId>.txt`. Do not trust the client file name as a path.
- Return a presigned **PUT** URL for that key with `ContentType: "text/plain"`, valid for a short time (for example 300 seconds).
- Optionally write a DynamoDB item with `status: "PENDING"` so the upload appears in the list before processing finishes.

Response (`200`):

```json
{ "uploadUrl": "https://...amazonaws.com/incoming/...?X-Amz-...", "documentId": "3f2a...", "key": "incoming/3f2a....txt", "expiresIn": 300 }
```

### `GET /documents`

Response (`200`): either an array or `{ "items": [ ... ] }`, where each item is a document (see below).

### `GET /documents/{documentId}`

Response (`200`): one document. Return `404` if no record exists yet. While polling after an
upload, the frontend treats 404 as "still processing".

### Document shape

```json
{
  "documentId": "3f2a...",
  "fileName": "notes.txt",
  "s3Key": "incoming/3f2a....txt",
  "status": "COMPLETED",
  "uploadedAt": "2026-10-14T09:30:00Z",
  "processedAt": "2026-10-14T09:30:02Z",
  "fileSize": 12345,
  "wordCount": 1520,
  "characterCount": 8840,
  "paragraphCount": 14,
  "topKeywords": [{ "word": "cloud", "count": 22 }, { "word": "lambda", "count": 17 }],
  "errorMessage": null
}
```

Notes:

- `status` values recognised: `PENDING`/`PROCESSING`/`UPLOADED` → Pending; `COMPLETED`/`PROCESSED`/`SUCCESS` → Processed; `FAILED`/`ERROR` → Failed. If a record has no `status` but has a word count, it is shown as Processed, because the current processor only writes after it finishes.
- `topKeywords` may also be a map (`{ "cloud": 22 }`) or a list of pairs.
- Dates may be ISO strings or epoch seconds/milliseconds.
- **DynamoDB returns numbers as `Decimal` in Python (boto3).** Convert them to `int` before calling `json.dumps`, or the Lambda will raise a serialisation error.
- Check the attribute names `DocumentProcessor` actually writes, and the table's partition key, so that `documentId` from `POST /uploads` matches the key used by `GET /documents/{documentId}`. The simplest approach is for the processor to derive the ID from the object key `incoming/<documentId>.txt`.

### CORS

- **API Gateway** (HTTP API → CORS): allow your frontend origin (for example `http://localhost:8080` and the deployed site), methods `GET, POST, OPTIONS`, header `content-type`.
- **S3 bucket CORS** (required for the browser's presigned PUT):

```json
[
  {
    "AllowedOrigins": ["http://localhost:8080"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3000
  }
]
```

Keep **Block Public Access** turned on. Presigned URLs work without making the bucket public.

### API Lambda IAM permissions (least privilege)

- `s3:PutObject` on `arn:aws:s3:::serverless-doc-analytics-ram-2026-73921/incoming/*`
- `dynamodb:GetItem`, `dynamodb:Scan` (or `Query`), plus `dynamodb:PutItem` if writing PENDING records, on the `DocumentAnalyticsV3` table ARN
- `AWSLambdaBasicExecutionRole` for CloudWatch Logs

### Connect the frontend

After deploying, set the invoke URL in `config.js`:

```js
apiBaseUrl: "https://<api-id>.execute-api.ap-southeast-2.amazonaws.com"
```

Reload the page. The status pill in the top bar changes to **API connected** once
`GET /documents` succeeds. The **API setup** page shows the result of the last check.

## Security notes

- No AWS credentials exist anywhere in the frontend. The browser only holds a short-lived presigned URL scoped to one object.
- The S3 bucket stays private.
- Frontend validation (TXT only, ≤ 1 MB) is for usability. The API Lambda must enforce the same rules, and `DocumentProcessor` should also reject oversized or non-TXT input.
- The API currently has no authentication. For anything beyond a demo, add an authoriser (for example Amazon Cognito JWT) and rate limiting/throttling on API Gateway.

## Not supported yet

- **PDF uploads** are disabled. Enable them only after `DocumentProcessor` can extract PDF text: add `.pdf` / `application/pdf` to `config.js` and update the API Lambda validation.
- Pagination of `GET /documents`. The frontend filters and sorts client-side; add `LastEvaluatedKey` pagination when the table grows.
