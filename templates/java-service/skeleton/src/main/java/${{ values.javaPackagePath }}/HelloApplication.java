package ${{ values.javaPackage }};

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

@SpringBootApplication
public class HelloApplication {

    public static final String SERVICE_NAME = "${{ values.name }}";

    public static void main(String[] args) {
        SpringApplication.run(HelloApplication.class, args);
    }
}
