package ${{ values.javaPackage }};

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.availability.ApplicationAvailability;
import org.springframework.boot.availability.ReadinessState;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HelloController {

    public record CreateItemRequest(String name) {}

    private final ItemStore store;
    private final ApplicationAvailability availability;
    private final String version;
    private final Counter namedGreetings;
    private final Counter anonymousGreetings;

    public HelloController(ItemStore store, ApplicationAvailability availability, MeterRegistry registry,
                           @Value("${app.version}") String version) {
        this.store = store;
        this.availability = availability;
        this.version = version;
        this.namedGreetings = greetingCounter(registry, "true");
        this.anonymousGreetings = greetingCounter(registry, "false");
        Gauge.builder("app.info", () -> 1)
                .description("Static application info.")
                .tags("service", HelloApplication.SERVICE_NAME, "version", version, "language", "java")
                .register(registry);
    }

    private static Counter greetingCounter(MeterRegistry registry, String named) {
        return Counter.builder("hello.greetings")
                .description("Number of greetings served, by whether a custom name was given.")
                .tag("named", named)
                .register(registry);
    }

    @GetMapping("/")
    public Map<String, String> root() {
        return Map.of("message", "Hello, World!", "service", HelloApplication.SERVICE_NAME, "version", version);
    }

    @GetMapping("/api/hello")
    public Map<String, String> hello(@RequestParam(required = false) String name) {
        boolean named = name != null && !name.isBlank();
        (named ? namedGreetings : anonymousGreetings).increment();
        return Map.of("message", "Hello, " + (named ? name : "World") + "!");
    }

    @GetMapping("/api/items")
    public List<ItemStore.Item> listItems() {
        return store.list();
    }

    @PostMapping("/api/items")
    public ResponseEntity<?> createItem(@RequestBody(required = false) CreateItemRequest body) {
        if (body == null || body.name() == null || body.name().isEmpty()) {
            return error(HttpStatus.BAD_REQUEST, "body must be JSON with a non-empty 'name'");
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(store.create(body.name()));
    }

    @GetMapping("/api/items/{id}")
    public ResponseEntity<?> getItem(@PathVariable int id) {
        return store.get(id)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> error(HttpStatus.NOT_FOUND, "item not found"));
    }

    @DeleteMapping("/api/items/{id}")
    public ResponseEntity<?> deleteItem(@PathVariable int id) {
        return store.delete(id) ? ResponseEntity.noContent().build() : error(HttpStatus.NOT_FOUND, "item not found");
    }

    @GetMapping("/healthz")
    public Map<String, String> healthz() {
        return Map.of("status", "ok");
    }

    @GetMapping("/readyz")
    public ResponseEntity<Map<String, String>> readyz() {
        boolean ready = availability.getReadinessState() == ReadinessState.ACCEPTING_TRAFFIC;
        return ResponseEntity.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of("status", ready ? "ready" : "not ready"));
    }

    private static ResponseEntity<Map<String, String>> error(HttpStatus status, String message) {
        return ResponseEntity.status(status).body(Map.of("error", message));
    }
}
