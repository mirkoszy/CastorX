package ${{ values.javaPackage }};

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

/**
 * Records {@code http_requests_total} and {@code http_request_duration_seconds} with the same names and labels
 * as the Go, Python and Node.js templates, so one dashboard works for every language.
 * (Spring's built-in {@code http_server_requests_seconds} metric is still exported as well.)
 */
@Component
public class HttpMetricsFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(HttpMetricsFilter.class);
    private static final Set<String> UNINSTRUMENTED = Set.of("/healthz", "/readyz", "/metrics");

    private final MeterRegistry registry;

    public HttpMetricsFilter(MeterRegistry registry) {
        this.registry = registry;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return UNINSTRUMENTED.contains(request.getRequestURI());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        long start = System.nanoTime();
        try {
            chain.doFilter(request, response);
        } finally {
            long elapsedNanos = System.nanoTime() - start;
            // Route template (e.g. /api/items/{id}), never the raw path, to keep label cardinality bounded.
            Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
            String route = pattern != null ? pattern.toString() : "unmatched";
            String method = request.getMethod();
            int status = response.getStatus();

            Timer.builder("http.request.duration")
                    .description("HTTP request latency in seconds.")
                    .tags("method", method, "route", route)
                    .publishPercentileHistogram()
                    .register(registry)
                    .record(elapsedNanos, java.util.concurrent.TimeUnit.NANOSECONDS);
            Counter.builder("http.requests")
                    .description("Total HTTP requests by method, route and status code.")
                    .tags("method", method, "route", route, "status", String.valueOf(status))
                    .register(registry)
                    .increment();
            log.info("request method={} path={} status={} duration_ms={}",
                    method, request.getRequestURI(), status, elapsedNanos / 1_000_000);
        }
    }
}
