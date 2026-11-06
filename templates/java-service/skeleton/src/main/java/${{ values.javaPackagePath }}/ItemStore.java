package ${{ values.javaPackage }};

import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentSkipListMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.stereotype.Component;

/** Thread-safe in-memory item store. Exposes its size as the {@code hello_items} gauge. */
@Component
public class ItemStore {

    public record Item(int id, String name, Instant createdAt) {}

    private final AtomicInteger nextId = new AtomicInteger(1);
    private final Map<Integer, Item> items = new ConcurrentSkipListMap<>();

    public ItemStore(MeterRegistry registry) {
        Gauge.builder("hello.items", items, Map::size)
                .description("Current number of items in the in-memory store.")
                .register(registry);
    }

    public List<Item> list() {
        return new ArrayList<>(items.values());
    }

    public Optional<Item> get(int id) {
        return Optional.ofNullable(items.get(id));
    }

    public Item create(String name) {
        Item item = new Item(nextId.getAndIncrement(), name, Instant.now());
        items.put(item.id(), item);
        return item;
    }

    public boolean delete(int id) {
        return items.remove(id) != null;
    }
}
