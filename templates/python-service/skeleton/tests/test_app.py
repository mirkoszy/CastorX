from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_hello():
    r = client.get("/api/hello", params={"name": "CastorX"})
    assert r.status_code == 200
    assert r.json() == {"message": "Hello, CastorX!"}


def test_items_lifecycle():
    r = client.post("/api/items", json={"name": "first"})
    assert r.status_code == 201
    item_id = r.json()["id"]
    assert client.get(f"/api/items/{item_id}").json()["name"] == "first"
    assert client.get("/api/items/9999").status_code == 404
    assert client.post("/api/items", json={"name": ""}).status_code == 422
    assert client.delete(f"/api/items/{item_id}").status_code == 204


def test_metrics():
    client.get("/api/hello")
    body = client.get("/metrics").text
    for m in ["http_requests_total", "http_request_duration_seconds", "hello_greetings_total", "app_info"]:
        assert m in body
    assert 'route="/api/hello"' in body
