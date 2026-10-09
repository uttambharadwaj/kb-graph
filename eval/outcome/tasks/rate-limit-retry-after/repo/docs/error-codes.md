# API error codes

| Code | HTTP status | Client action |
| --- | --- | --- |
| INVALID_INPUT | 400 | Fix the request; do not retry unchanged. |
| UNAUTHORIZED | 401 | Refresh credentials, then retry. |
| NOT_FOUND | 404 | Do not retry. |
