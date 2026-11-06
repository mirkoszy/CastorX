package ${{ values.javaPackage }};

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.actuate.observability.AutoConfigureObservability;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest
@AutoConfigureMockMvc
@AutoConfigureObservability // metrics export is disabled in tests unless enabled explicitly
class HelloApplicationTests {

    @Autowired
    private MockMvc mvc;

    @Test
    void helloGreetsByName() throws Exception {
        mvc.perform(get("/api/hello").param("name", "CastorX"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.message").value("Hello, CastorX!"));
    }

    @Test
    void itemsLifecycle() throws Exception {
        mvc.perform(post("/api/items").contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"first\"}"))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.name").value("first"));
        mvc.perform(get("/api/items/1")).andExpect(status().isOk());
        mvc.perform(get("/api/items/9999")).andExpect(status().isNotFound());
        mvc.perform(post("/api/items").contentType(MediaType.APPLICATION_JSON).content("{\"name\":\"\"}"))
                .andExpect(status().isBadRequest());
        mvc.perform(delete("/api/items/1")).andExpect(status().isNoContent());
    }

    @Test
    void metricsAreExposed() throws Exception {
        mvc.perform(get("/api/hello")).andExpect(status().isOk());
        mvc.perform(get("/metrics"))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("http_requests_total")))
                .andExpect(content().string(containsString("http_request_duration_seconds")))
                .andExpect(content().string(containsString("hello_greetings_total")))
                .andExpect(content().string(containsString("app_info")));
    }

    @Test
    void probes() throws Exception {
        mvc.perform(get("/healthz")).andExpect(status().isOk());
        mvc.perform(get("/readyz")).andExpect(status().isOk());
    }
}
