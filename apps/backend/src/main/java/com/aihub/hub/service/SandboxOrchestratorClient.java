package com.aihub.hub.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.util.StreamUtils;
import org.springframework.web.client.RestClient;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Component
public class SandboxOrchestratorClient {

    private static final Logger log = LoggerFactory.getLogger(SandboxOrchestratorClient.class);
    private static final int MAX_LOG_BODY_LENGTH = 2_000;

    private final RestClient restClient;
    private final String jobsPath;
    private final ObjectMapper objectMapper;

    public SandboxOrchestratorClient(
        RestClient sandboxOrchestratorRestClient,
        ObjectMapper objectMapper,
        @Value("${hub.sandbox.orchestrator.jobs-path:/jobs}") String jobsPath
    ) {
        this.restClient = sandboxOrchestratorRestClient;
        this.objectMapper = objectMapper;
        this.jobsPath = jobsPath;
    }

    public SandboxOrchestratorJobResponse createJob(SandboxJobRequest request) {
        Map<String, Object> body = new HashMap<>();
        body.put("jobId", request.jobId());
        Optional.ofNullable(request.repoSlug()).ifPresent(value -> body.put("repoSlug", value));
        Optional.ofNullable(request.repoUrl()).ifPresent(value -> body.put("repoUrl", value));
        body.put("branch", request.branch());
        body.put("taskDescription", request.taskDescription());
        Optional.ofNullable(request.commitHash()).ifPresent(value -> body.put("commit", value));
        Optional.ofNullable(request.testCommand()).ifPresent(value -> body.put("testCommand", value));
        Optional.ofNullable(request.profile()).ifPresent(value -> body.put("profile", value));
        Optional.ofNullable(request.model()).ifPresent(value -> body.put("model", value));

        log.info("Enviando job {} para sandbox-orchestrator no path {}", request.jobId(), jobsPath);
        JsonNode response = executeForJsonResponse(restClient.post()
            .uri(jobsPath)
            .contentType(MediaType.APPLICATION_JSON)
            .body(body)
            , "criar job", false);

        return SandboxOrchestratorJobResponse.from(response);
    }

    public SandboxOrchestratorJobResponse createUploadJob(SandboxUploadJobRequest request) {
        Map<String, Object> body = new HashMap<>();
        body.put("jobId", request.jobId());
        body.put("taskDescription", request.taskDescription());
        body.put("branch", Optional.ofNullable(request.branch()).orElse("upload"));
        body.put("repoUrl", Optional.ofNullable(request.repoUrl()).orElse("upload://" + request.jobId()));
        Optional.ofNullable(request.testCommand()).ifPresent(value -> body.put("testCommand", value));
        Optional.ofNullable(request.profile()).ifPresent(value -> body.put("profile", value));
        Optional.ofNullable(request.model()).ifPresent(value -> body.put("model", value));

        Map<String, Object> upload = new HashMap<>();
        upload.put("base64", request.base64Zip());
        Optional.ofNullable(request.zipName()).ifPresent(value -> upload.put("filename", value));
        body.put("uploadedZip", upload);

        if (request.problemFiles() != null && !request.problemFiles().isEmpty()) {
            List<Map<String, Object>> problemFiles = new java.util.ArrayList<>();
            for (var file : request.problemFiles()) {
                if (file == null) {
                    continue;
                }
                Map<String, Object> attachment = new HashMap<>();
                attachment.put("base64", file.base64());
                attachment.put("filename", file.filename());
                Optional.ofNullable(file.contentType()).ifPresent(value -> attachment.put("contentType", value));
                problemFiles.add(attachment);
            }
            if (!problemFiles.isEmpty()) {
                body.put("problemFiles", problemFiles);
            }
        }
        if (request.applicationDefaultCredentials() != null) {
            Map<String, Object> credentials = new HashMap<>();
            credentials.put("base64", request.applicationDefaultCredentials().base64());
            Optional.ofNullable(request.applicationDefaultCredentials().filename())
                .ifPresent(value -> credentials.put("filename", value));
            Optional.ofNullable(request.applicationDefaultCredentials().contentType())
                .ifPresent(value -> credentials.put("contentType", value));
            body.put("applicationDefaultCredentials", credentials);
        }


        log.info("Enviando job {} (upload) para sandbox-orchestrator no path {}", request.jobId(), jobsPath);
        JsonNode response = executeForJsonResponse(restClient.post()
            .uri(jobsPath)
            .contentType(MediaType.APPLICATION_JSON)
            .body(body)
            , "criar job upload", false);

        return SandboxOrchestratorJobResponse.from(response);
    }

    public SandboxOrchestratorJobResponse getJob(String jobId) {
        log.info("Consultando job {} no sandbox-orchestrator", jobId);
        JsonNode response = executeForJsonResponse(restClient.get()
            .uri(jobsPath + "/" + jobId)
            , "consultar job", true);
        return SandboxOrchestratorJobResponse.from(response);
    }

    private JsonNode executeForJsonResponse(RestClient.RequestHeadersSpec<?> requestSpec,
                                            String operationDescription,
                                            boolean allowNotFound) {
        return requestSpec.exchange((request, response) -> {
            HttpStatusCode status = response.getStatusCode();
            MediaType contentType = response.getHeaders().getContentType();
            String body = readBody(response);

            if (allowNotFound && status.value() == 404) {
                log.warn("Job não encontrado no sandbox-orchestrator (operação: {})", operationDescription);
                return null;
            }

            if (!status.is2xxSuccessful()) {
                logIfNeeded(status, contentType, body);
                throw new IllegalStateException(buildErrorMessage(status, contentType));
            }

            if (!isJsonContentType(contentType)) {
                logIfNeeded(status, contentType, body);
                throw new IllegalStateException(buildErrorMessage(status, contentType));
            }

            if (body == null || body.isBlank()) {
                logIfNeeded(status, contentType, body);
                throw new IllegalStateException("sandbox-orchestrator retornou " + status.value() + " com corpo vazio");
            }

            if (!looksLikeJson(body)) {
                logIfNeeded(status, contentType, body);
                throw new IllegalStateException("sandbox-orchestrator retornou " + status.value()
                    + " com corpo inválido (JSON esperado)");
            }

            return readJsonTree(body, status, contentType);
        });
    }

    private String readBody(RestClient.RequestHeadersSpec.ConvertibleClientHttpResponse response) {
        try {
            return StreamUtils.copyToString(response.getBody(), StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new IllegalStateException("Falha ao ler resposta do sandbox-orchestrator", ex);
        }
    }

    private JsonNode readJsonTree(String body, HttpStatusCode status, MediaType contentType) {
        try {
            return objectMapper.readTree(body);
        } catch (JsonProcessingException ex) {
            logIfNeeded(status, contentType, body);
            throw new IllegalStateException("sandbox-orchestrator retornou " + status.value()
                + " com corpo inválido (JSON esperado)", ex);
        }
    }

    private boolean looksLikeJson(String body) {
        String trimmed = body.trim();
        if (trimmed.isEmpty()) {
            return false;
        }
        char first = trimmed.charAt(0);
        char last = trimmed.charAt(trimmed.length() - 1);
        return (first == '{' && last == '}') || (first == '[' && last == ']');
    }

    private void logIfNeeded(HttpStatusCode status, MediaType contentType, String body) {
        log.warn("Resposta inesperada do sandbox-orchestrator: status={}, content-type={}, body={}",
            status.value(),
            formatContentType(contentType),
            truncateBody(body));
    }

    private String buildErrorMessage(HttpStatusCode status, MediaType contentType) {
        return "sandbox-orchestrator retornou " + status.value() + " com corpo " + formatContentType(contentType);
    }

    private String formatContentType(MediaType contentType) {
        if (contentType == null) {
            return "desconhecido";
        }
        return contentType.toString();
    }

    private String truncateBody(String body) {
        if (body == null) {
            return "";
        }
        if (body.length() <= MAX_LOG_BODY_LENGTH) {
            return body;
        }
        return body.substring(0, MAX_LOG_BODY_LENGTH) + "...(truncado)";
    }

    private boolean isJsonContentType(MediaType contentType) {
        if (contentType == null) {
            return false;
        }
        if (MediaType.APPLICATION_JSON.isCompatibleWith(contentType)) {
            return true;
        }
        String subtype = contentType.getSubtype();
        return subtype != null && subtype.endsWith("+json");
    }

    public record SandboxOrchestratorJobResponse(
        String jobId,
        String status,
        String summary,
        List<String> changedFiles,
        String patch,
        String resultZipBase64,
        String resultZipFilename,
        String pullRequestUrl,
        String error,
        Integer promptTokens,
        Integer cachedPromptTokens,
        Integer completionTokens,
        Integer totalTokens,
        BigDecimal cost
    ) {
        public static SandboxOrchestratorJobResponse from(JsonNode node) {
            if (node == null || node.isMissingNode()) {
                return null;
            }
            List<String> files = Optional.ofNullable(node.path("changedFiles"))
                .filter(JsonNode::isArray)
                .stream()
                .flatMap(array -> {
                    java.util.List<String> values = new java.util.ArrayList<>();
                    array.forEach(item -> {
                        String text = item.asText(null);
                        if (text != null && !text.isBlank()) {
                            values.add(text.trim());
                        }
                    });
                    return values.stream();
                })
                .toList();

            String resultZipBase64 = readText(node, "resultZipBase64", "result_zip_base64");
            String resultZipFilename = readText(node, "resultZipFilename", "result_zip_filename");

            return new SandboxOrchestratorJobResponse(
                node.path("jobId").asText(null),
                node.path("status").asText(null),
                node.path("summary").asText(null),
                files.isEmpty() ? null : files,
                node.path("patch").asText(null),
                resultZipBase64,
                resultZipFilename,
                resolvePullRequestUrl(node),
                node.path("error").asText(null),
                resolvePromptTokens(node),
                resolveCachedPromptTokens(node),
                resolveCompletionTokens(node),
                resolveTotalTokens(node),
                resolveCost(node)
            );
        }

        private static Integer resolvePromptTokens(JsonNode node) {
            Integer topLevel = readInt(node, "promptTokens", "prompt_tokens");
            if (topLevel != null) {
                return topLevel;
            }
            return readInt(node.path("usage"), "promptTokens", "prompt_tokens", "input_tokens");
        }


        private static Integer resolveCachedPromptTokens(JsonNode node) {
            Integer topLevel = readInt(node, "cachedPromptTokens", "cached_prompt_tokens", "cachedInputTokens", "cached_input_tokens");
            if (topLevel != null) {
                return topLevel;
            }
            return readInt(node.path("usage"), "cachedPromptTokens", "cached_prompt_tokens", "cachedInputTokens", "cached_input_tokens");
        }

        private static Integer resolveCompletionTokens(JsonNode node) {
            Integer topLevel = readInt(node, "completionTokens", "completion_tokens");
            if (topLevel != null) {
                return topLevel;
            }
            return readInt(node.path("usage"), "completionTokens", "completion_tokens", "output_tokens");
        }

        private static Integer resolveTotalTokens(JsonNode node) {
            Integer topLevel = readInt(node, "totalTokens", "total_tokens");
            if (topLevel != null) {
                return topLevel;
            }
            return readInt(node.path("usage"), "totalTokens", "total_tokens");
        }

        private static BigDecimal resolveCost(JsonNode node) {
            BigDecimal topLevel = readDecimal(node, "cost", "total_cost");
            if (topLevel != null) {
                return topLevel;
            }
            return readDecimal(node.path("usage"), "cost", "total_cost");
        }

        private static String resolvePullRequestUrl(JsonNode node) {
            return readText(node, "pullRequestUrl", "pull_request_url");
        }

        private static Integer readInt(JsonNode node, String... fields) {
            for (String field : fields) {
                JsonNode target = node.path(field);
                if (target.isNumber()) {
                    return target.intValue();
                }
                if (target.isTextual()) {
                    try {
                        return Integer.parseInt(target.asText().trim());
                    } catch (NumberFormatException ignored) {
                        // noop
                    }
                }
            }
            return null;
        }

        private static BigDecimal readDecimal(JsonNode node, String... fields) {
            for (String field : fields) {
                JsonNode target = node.path(field);
                if (target.isNumber()) {
                    return target.decimalValue();
                }
                if (target.isTextual()) {
                    try {
                        return new BigDecimal(target.asText().trim());
                    } catch (NumberFormatException ignored) {
                        // noop
                    }
                }
            }
            return null;
        }

        private static String readText(JsonNode node, String... fields) {
            for (String field : fields) {
                JsonNode target = node.path(field);
                if (target.isTextual()) {
                    String text = target.asText().trim();
                    if (!text.isBlank()) {
                        return text;
                    }
                }
            }
            return null;
        }
    }
}
