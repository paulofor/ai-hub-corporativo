package com.aihub.hub.domain;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.math.BigDecimal;
import java.time.Instant;

@Entity
@Table(name = "upload_jobs")
public class UploadJobRecord {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "job_id", nullable = false, unique = true)
    private String jobId;

    @Column(name = "task_description", nullable = false)
    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    private String taskDescription;

    @Column(name = "test_command")
    private String testCommand;

    private String profile;

    private String model;

    @Column(name = "zip_name")
    private String zipName;

    @Column(nullable = false)
    private String status;

    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    private String summary;

    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    private String error;

    @Column(name = "changed_files")
    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    private String changedFiles;

    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    private String patch;

    @Column(name = "result_zip_base64")
    @JdbcTypeCode(SqlTypes.LONGVARCHAR)
    private String resultZipBase64;

    @Column(name = "result_zip_filename")
    private String resultZipFilename;

    @Column(name = "result_zip_ready")
    private Boolean resultZipReady = Boolean.FALSE;

    @Column(name = "pull_request_url")
    private String pullRequestUrl;

    @Column(name = "prompt_tokens")
    private Integer promptTokens;

    @Column(name = "cached_prompt_tokens")
    private Integer cachedPromptTokens;

    @Column(name = "completion_tokens")
    private Integer completionTokens;

    @Column(name = "total_tokens")
    private Integer totalTokens;

    private BigDecimal cost;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at")
    private Instant updatedAt = Instant.now();

    public Long getId() {
        return id;
    }

    public String getJobId() {
        return jobId;
    }

    public void setJobId(String jobId) {
        this.jobId = jobId;
    }

    public String getTaskDescription() {
        return taskDescription;
    }

    public void setTaskDescription(String taskDescription) {
        this.taskDescription = taskDescription;
    }

    public String getTestCommand() {
        return testCommand;
    }

    public void setTestCommand(String testCommand) {
        this.testCommand = testCommand;
    }

    public String getProfile() {
        return profile;
    }

    public void setProfile(String profile) {
        this.profile = profile;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public String getZipName() {
        return zipName;
    }

    public void setZipName(String zipName) {
        this.zipName = zipName;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public String getSummary() {
        return summary;
    }

    public void setSummary(String summary) {
        this.summary = summary;
    }

    public String getError() {
        return error;
    }

    public void setError(String error) {
        this.error = error;
    }

    public String getChangedFiles() {
        return changedFiles;
    }

    public void setChangedFiles(String changedFiles) {
        this.changedFiles = changedFiles;
    }

    public String getPatch() {
        return patch;
    }

    public void setPatch(String patch) {
        this.patch = patch;
    }

    public String getResultZipBase64() {
        return resultZipBase64;
    }

    public void setResultZipBase64(String resultZipBase64) {
        this.resultZipBase64 = resultZipBase64;
    }

    public String getResultZipFilename() {
        return resultZipFilename;
    }

    public void setResultZipFilename(String resultZipFilename) {
        this.resultZipFilename = resultZipFilename;
    }

    public Boolean getResultZipReady() {
        return resultZipReady;
    }

    public void setResultZipReady(Boolean resultZipReady) {
        this.resultZipReady = resultZipReady;
    }

    public String getPullRequestUrl() {
        return pullRequestUrl;
    }

    public void setPullRequestUrl(String pullRequestUrl) {
        this.pullRequestUrl = pullRequestUrl;
    }

    public Integer getPromptTokens() {
        return promptTokens;
    }

    public void setPromptTokens(Integer promptTokens) {
        this.promptTokens = promptTokens;
    }

    public Integer getCachedPromptTokens() {
        return cachedPromptTokens;
    }

    public void setCachedPromptTokens(Integer cachedPromptTokens) {
        this.cachedPromptTokens = cachedPromptTokens;
    }

    public Integer getCompletionTokens() {
        return completionTokens;
    }

    public void setCompletionTokens(Integer completionTokens) {
        this.completionTokens = completionTokens;
    }

    public Integer getTotalTokens() {
        return totalTokens;
    }

    public void setTotalTokens(Integer totalTokens) {
        this.totalTokens = totalTokens;
    }

    public BigDecimal getCost() {
        return cost;
    }

    public void setCost(BigDecimal cost) {
        this.cost = cost;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public void setUpdatedAt(Instant updatedAt) {
        this.updatedAt = updatedAt;
    }
}
