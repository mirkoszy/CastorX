// ${{ values.name }}: CastorX service with a small REST API and Prometheus metrics.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

const serviceName = "${{ values.name }}"

var version = getenv("APP_VERSION", "0.1.0")

// ---- Metrics ----------------------------------------------------------------

var (
	httpRequests = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total",
		Help: "Total HTTP requests by method, route and status code.",
	}, []string{"method", "route", "status"})

	httpDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP request latency in seconds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "route"})

	greetings = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "hello_greetings_total",
		Help: "Number of greetings served, by whether a custom name was given.",
	}, []string{"named"})

	itemsGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "hello_items",
		Help: "Current number of items in the in-memory store.",
	})

	_ = promauto.NewGaugeFunc(prometheus.GaugeOpts{
		Name:        "app_info",
		Help:        "Static application info.",
		ConstLabels: prometheus.Labels{"service": serviceName, "version": version, "language": "go"},
	}, func() float64 { return 1 })
)

// ---- In-memory store ---------------------------------------------------------

type Item struct {
	ID        int       `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

type store struct {
	mu     sync.RWMutex
	nextID int
	items  map[int]Item
}

func newStore() *store { return &store{nextID: 1, items: map[int]Item{}} }

func (s *store) list() []Item {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Item, 0, len(s.items))
	for i := 1; i < s.nextID; i++ {
		if it, ok := s.items[i]; ok {
			out = append(out, it)
		}
	}
	return out
}

func (s *store) get(id int) (Item, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	it, ok := s.items[id]
	return it, ok
}

func (s *store) create(name string) Item {
	s.mu.Lock()
	defer s.mu.Unlock()
	it := Item{ID: s.nextID, Name: name, CreatedAt: time.Now().UTC()}
	s.items[it.ID] = it
	s.nextID++
	itemsGauge.Set(float64(len(s.items)))
	return it
}

func (s *store) delete(id int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.items[id]; !ok {
		return false
	}
	delete(s.items, id)
	itemsGauge.Set(float64(len(s.items)))
	return true
}

// ---- HTTP helpers ------------------------------------------------------------

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

// instrument wraps a handler and records metrics under a fixed route label
// (never the raw path, to keep label cardinality bounded).
func instrument(route string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h(rec, r)
		elapsed := time.Since(start)
		httpDuration.WithLabelValues(r.Method, route).Observe(elapsed.Seconds())
		httpRequests.WithLabelValues(r.Method, route, strconv.Itoa(rec.status)).Inc()
		slog.Info("request", "method", r.Method, "path", r.URL.Path, "status", rec.status, "duration_ms", elapsed.Milliseconds())
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ---- Routes ------------------------------------------------------------------

func newMux(s *store) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /{$}", instrument("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"message": "Hello, World!", "service": serviceName, "version": version})
	}))

	mux.HandleFunc("GET /api/hello", instrument("/api/hello", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		named := "true"
		if name == "" {
			name, named = "World", "false"
		}
		greetings.WithLabelValues(named).Inc()
		writeJSON(w, http.StatusOK, map[string]string{"message": "Hello, " + name + "!"})
	}))

	mux.HandleFunc("GET /api/items", instrument("/api/items", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, s.list())
	}))

	mux.HandleFunc("POST /api/items", instrument("/api/items", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
			writeError(w, http.StatusBadRequest, "body must be JSON with a non-empty 'name'")
			return
		}
		writeJSON(w, http.StatusCreated, s.create(body.Name))
	}))

	mux.HandleFunc("GET /api/items/{id}", instrument("/api/items/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "id must be an integer")
			return
		}
		it, ok := s.get(id)
		if !ok {
			writeError(w, http.StatusNotFound, "item not found")
			return
		}
		writeJSON(w, http.StatusOK, it)
	}))

	mux.HandleFunc("DELETE /api/items/{id}", instrument("/api/items/{id}", func(w http.ResponseWriter, r *http.Request) {
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			writeError(w, http.StatusBadRequest, "id must be an integer")
			return
		}
		if !s.delete(id) {
			writeError(w, http.StatusNotFound, "item not found")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	// Probes and metrics are not instrumented to keep dashboards clean.
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	mux.Handle("GET /metrics", promhttp.Handler())

	return mux
}

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	port := getenv("PORT", "8080")
	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           newMux(newStore()),
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		slog.Info("starting", "service", serviceName, "version", version, "port", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	// Graceful shutdown on SIGTERM (Kubernetes / Cloud Run) or Ctrl+C.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	slog.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
