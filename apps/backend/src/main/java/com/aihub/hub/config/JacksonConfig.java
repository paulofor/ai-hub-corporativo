package com.aihub.hub.config;

import com.fasterxml.jackson.core.StreamReadConstraints;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class JacksonConfig {

    private static final int MAX_STRING_LENGTH = 200 * 1024 * 1024;

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer streamReadConstraintsCustomizer() {
        return builder -> builder.postConfigurer(objectMapper -> {
            StreamReadConstraints constraints = StreamReadConstraints.builder()
                .maxStringLength(MAX_STRING_LENGTH)
                .build();
            objectMapper.getFactory().setStreamReadConstraints(constraints);
        });
    }
}
