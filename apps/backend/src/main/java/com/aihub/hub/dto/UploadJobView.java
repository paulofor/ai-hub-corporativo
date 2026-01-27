package com.aihub.hub.dto;

import com.aihub.hub.domain.UploadJobRecord;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;

public record UploadJobView(
    Long id,
    String jobId,
    String title,
    String taskDescription,
    String testCommand,
    String profile,
    String model,
    String status,
    String summary,
    String error,
    List<String> changedFiles,
    String patch,
    String resultZipBase64,
    String resultZipFilename,
    Boolean resultZipReady,
    String pullRequestUrl,
    Integer promptTokens,
    Integer cachedPromptTokens,
    Integer completionTokens,
    Integer totalTokens,
    BigDecimal cost,
    Instant createdAt,
    Instant updatedAt
) {
    private static final int MAX_TITLE_LENGTH = 20;

    public static UploadJobView from(UploadJobRecord record) {
        List<String> files = null;
        if (record.getChangedFiles() != null && !record.getChangedFiles().isBlank()) {
            files = Arrays.stream(record.getChangedFiles().split("\n"))
                .map(String::trim)
                .filter(it -> !it.isBlank())
                .toList();
        }

        return new UploadJobView(
            record.getId(),
            record.getJobId(),
            buildTitle(record.getTaskDescription()),
            record.getTaskDescription(),
            record.getTestCommand(),
            record.getProfile(),
            record.getModel(),
            record.getStatus(),
            record.getSummary(),
            record.getError(),
            files,
            record.getPatch(),
            record.getResultZipBase64(),
            record.getResultZipFilename(),
            record.getResultZipReady(),
            record.getPullRequestUrl(),
            record.getPromptTokens(),
            record.getCachedPromptTokens(),
            record.getCompletionTokens(),
            record.getTotalTokens(),
            record.getCost(),
            record.getCreatedAt(),
            record.getUpdatedAt()
        );
    }

    private static String buildTitle(String taskDescription) {
        if (taskDescription == null || taskDescription.isBlank()) {
            return "Sem título";
        }
        String normalized = taskDescription.replaceAll("\\s+", " ").trim();
        if (normalized.length() <= MAX_TITLE_LENGTH) {
            return normalized;
        }
        return normalized.substring(0, MAX_TITLE_LENGTH).trim();
    }
}
