FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /src
COPY pom.xml .
RUN mvn -q -B dependency:go-offline
COPY src ./src
RUN mvn -q -B package -DskipTests

FROM eclipse-temurin:21-jre-alpine
ARG APP_VERSION=0.1.0
ENV APP_VERSION=${APP_VERSION}
WORKDIR /app
COPY --from=build /src/target/app.jar app.jar
ENV PORT=8080 JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"
RUN adduser -D -u 10001 appuser
USER 10001
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
