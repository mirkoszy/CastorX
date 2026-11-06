# ${{ values.name }}

${{ values.description }}

Generated from the CastorX **Go service** template.

## Run

```bash
go run .
```

## Test

```bash
go test ./...
```

## API

| Method   | Path                | Description                         |
|----------|---------------------|-------------------------------------|
| `GET`    | `/`                 | Service info                        |
| `GET`    | `/api/hello?name=X` | Greeting                            |
| `GET`    | `/api/items`        | List items (in-memory store)        |
| `POST`   | `/api/items`        | Create item, body `{"name":"…"}`    |
| `GET`    | `/api/items/{id}`   | Get item                            |
| `DELETE` | `/api/items/{id}`   | Delete item                         |
| `GET`    | `/healthz`          | Liveness probe                      |
| `GET`    | `/readyz`           | Readiness probe                     |
| `GET`    | `/metrics`          | Prometheus metrics                  |

## Platform contract

- Listens on `$PORT` (default `8080`), logs to stdout, shuts down gracefully on `SIGTERM`.
- `APP_VERSION` sets the version reported by `/` and the `app_info` metric.
- Metrics: `http_requests_total`, `http_request_duration_seconds`, `app_info`
  (plus the example `hello_greetings_total` and `hello_items` — replace them with your own).
- CI builds and tests on every push and publishes a container image from the default branch.
