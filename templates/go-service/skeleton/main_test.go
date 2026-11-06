package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHello(t *testing.T) {
	mux := newMux(newStore())
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/hello?name=CastorX", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Hello, CastorX!") {
		t.Fatalf("unexpected response: %d %s", rec.Code, rec.Body.String())
	}
}

func TestItemsLifecycle(t *testing.T) {
	mux := newMux(newStore())

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/items", strings.NewReader(`{"name":"first"}`)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/items/1", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "first") {
		t.Fatalf("get: got %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/items/99", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing: got %d", rec.Code)
	}
}

func TestMetrics(t *testing.T) {
	mux := newMux(newStore())
	mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/hello", nil))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	for _, m := range []string{"http_requests_total", "http_request_duration_seconds", "hello_greetings_total", "app_info"} {
		if !strings.Contains(rec.Body.String(), m) {
			t.Errorf("metric %s missing", m)
		}
	}
}
