"""${{ values.name }}: CastorX service with a small REST API and Prometheus metrics."""
import logging
import os
import threading
import time
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.routing import APIRoute
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Gauge,
    Histogram,
    Info,
    disable_created_metrics,
    generate_latest,
)
from pydantic import BaseModel, Field

SERVICE_NAME = "${{ values.name }}"
VERSION = os.getenv("APP_VERSION", "0.1.0")

logging.basicConfig(level=logging.INFO, format='{"level":"%(levelname)s","msg":"%(message)s"}')
log = logging.getLogger(SERVICE_NAME)

# ---- Metrics -----------------------------------------------------------------

disable_created_metrics()  # skip the extra *_created series

HTTP_REQUESTS = Counter(
    "http_requests_total", "Total HTTP requests by method, route and status code.", ["method", "route", "status"]
)
HTTP_DURATION = Histogram("http_request_duration_seconds", "HTTP request latency in seconds.", ["method", "route"])
GREETINGS = Counter("hello_greetings_total", "Number of greetings served, by whether a custom name was given.", ["named"])
ITEMS = Gauge("hello_items", "Current number of items in the in-memory store.")
APP_INFO = Info("app", "Static application info.")  # exported as app_info{...} 1
APP_INFO.info({"service": SERVICE_NAME, "version": VERSION, "language": "python"})

UNINSTRUMENTED = {"/healthz", "/readyz", "/metrics"}

# ---- In-memory store -----------------------------------------------------------


class ItemIn(BaseModel):
    name: str = Field(min_length=1)


class Item(BaseModel):
    id: int
    name: str
    createdAt: datetime


class Store:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._next_id = 1
        self._items: dict[int, Item] = {}

    def list(self) -> list[Item]:
        with self._lock:
            return list(self._items.values())

    def get(self, item_id: int) -> Item | None:
        with self._lock:
            return self._items.get(item_id)

    def create(self, name: str) -> Item:
        with self._lock:
            item = Item(id=self._next_id, name=name, createdAt=datetime.now(timezone.utc))
            self._items[item.id] = item
            self._next_id += 1
            ITEMS.set(len(self._items))
            return item

    def delete(self, item_id: int) -> bool:
        with self._lock:
            removed = self._items.pop(item_id, None) is not None
            ITEMS.set(len(self._items))
            return removed


store = Store()
app = FastAPI(title=SERVICE_NAME, version=VERSION)

# ---- Middleware ------------------------------------------------------------------


@app.middleware("http")
async def metrics_middleware(request: Request, call_next):
    if request.url.path in UNINSTRUMENTED:
        return await call_next(request)
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        elapsed = time.perf_counter() - start
        # Use the route template (e.g. /api/items/{item_id}) to keep label cardinality bounded.
        route = request.scope.get("route")
        route_label = route.path if isinstance(route, APIRoute) else "unmatched"
        HTTP_DURATION.labels(request.method, route_label).observe(elapsed)
        HTTP_REQUESTS.labels(request.method, route_label, str(status)).inc()
        log.info("%s %s %s %.1fms", request.method, request.url.path, status, elapsed * 1000)


# ---- Routes ------------------------------------------------------------------------


@app.get("/")
def root():
    return {"message": "Hello, World!", "service": SERVICE_NAME, "version": VERSION}


@app.get("/api/hello")
def hello(name: str | None = None):
    GREETINGS.labels("true" if name else "false").inc()
    return {"message": f"Hello, {name or 'World'}!"}


@app.get("/api/items", response_model=list[Item])
def list_items():
    return store.list()


@app.post("/api/items", response_model=Item, status_code=201)
def create_item(body: ItemIn):
    return store.create(body.name)


@app.get("/api/items/{item_id}", response_model=Item)
def get_item(item_id: int):
    item = store.get(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="item not found")
    return item


@app.delete("/api/items/{item_id}", status_code=204)
def delete_item(item_id: int):
    if not store.delete(item_id):
        raise HTTPException(status_code=404, detail="item not found")
    return Response(status_code=204)


@app.get("/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/readyz")
def readyz():
    return {"status": "ready"}


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
