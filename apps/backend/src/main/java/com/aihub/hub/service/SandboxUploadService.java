package com.aihub.hub.service;

import com.aihub.hub.domain.UploadJobRecord;
import com.aihub.hub.dto.CreateUploadJobRequest;
import com.aihub.hub.dto.UploadJobView;
import com.aihub.hub.repository.UploadJobRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class SandboxUploadService {

    private static final Logger log = LoggerFactory.getLogger(SandboxUploadService.class);

    private final SandboxOrchestratorClient sandboxOrchestratorClient;
    private final AuditService auditService;
    private final UploadJobRepository uploadJobRepository;
    private final long maxInlineZipBytes;
    private final TokenCostCalculator tokenCostCalculator;
    private final String defaultUploadModel;

    public SandboxUploadService(SandboxOrchestratorClient sandboxOrchestratorClient,
                                AuditService auditService,
                                UploadJobRepository uploadJobRepository,
                                @Value("${hub.upload-jobs.max-inline-zip-bytes:8388608}") long maxInlineZipBytes,
                                TokenCostCalculator tokenCostCalculator,
                                @Value("${hub.upload-jobs.default-model:}") String uploadJobsDefaultModel,
                                @Value("${hub.codex.model:gpt-5-codex}") String codexDefaultModel) {
        this.sandboxOrchestratorClient = sandboxOrchestratorClient;
        this.auditService = auditService;
        this.uploadJobRepository = uploadJobRepository;
        this.maxInlineZipBytes = Math.max(0L, maxInlineZipBytes);
        this.tokenCostCalculator = tokenCostCalculator;
        this.defaultUploadModel = resolveDefaultModel(uploadJobsDefaultModel, codexDefaultModel);
    }

    @Transactional
    public UploadJobView createJob(String actor, CreateUploadJobRequest request) {
        MultipartFile sourceZip = request.getSourceZip();
        if (sourceZip == null || sourceZip.isEmpty()) {
            throw new IllegalArgumentException("Envie um arquivo ZIP válido");
        }

        String jobId = UUID.randomUUID().toString();
        String base64;
        try {
            base64 = Base64.getEncoder().encodeToString(sourceZip.getBytes());
        } catch (IOException e) {
            throw new IllegalStateException("Falha ao ler o arquivo ZIP enviado", e);
        }

        List<UploadedProblemFile> problemFiles = resolveProblemFiles(request.getProblemFiles());
        UploadedApplicationDefaultCredential applicationDefaultCredentials =
            resolveApplicationDefaultCredentials(request.getApplicationDefaultCredentials());
        UploadedGitSshKey gitSshPrivateKey = resolveGitSshPrivateKey(request.getGitSshPrivateKey());
        UploadedGitlabPersonalAccessToken gitlabPersonalAccessToken = resolveGitlabPersonalAccessToken(request.getGitlabPersonalAccessToken());
        String requestedModel = normalizeModel(request.getModel());
        String resolvedModel = requestedModel != null ? requestedModel : defaultUploadModel;

        SandboxUploadJobRequest payload = new SandboxUploadJobRequest(
            jobId,
            request.getTaskDescription(),
            base64,
            sourceZip.getOriginalFilename(),
            request.getTestCommand(),
            request.getProfile(),
            resolvedModel,
            "upload://" + jobId,
            "upload",
            problemFiles,
            applicationDefaultCredentials,
            gitSshPrivateKey,
            gitlabPersonalAccessToken
        );

        UploadJobRecord record = new UploadJobRecord();
        record.setJobId(jobId);
        record.setTaskDescription(request.getTaskDescription());
        record.setTestCommand(request.getTestCommand());
        record.setProfile(request.getProfile());
        record.setModel(resolvedModel);
        record.setZipName(sourceZip.getOriginalFilename());
        record.setStatus("PENDING");
        record.setResultZipReady(Boolean.FALSE);
        record.setResultZipBase64(null);
        record.setUpdatedAt(Instant.now());
        uploadJobRepository.save(record);

        try {
            SandboxOrchestratorClient.SandboxOrchestratorJobResponse response =
                sandboxOrchestratorClient.createUploadJob(payload);
            populateFromOrchestrator(record, response);
        } catch (RuntimeException ex) {
            record.setStatus("FAILED");
            String message = ex.getMessage() != null
                ? ex.getMessage()
                : "Falha ao criar job no sandbox-orchestrator";
            record.setError(message);
        }

        record.setUpdatedAt(Instant.now());
        uploadJobRepository.save(record);

        auditService.record(actor, "upload_job_created", sourceZip.getOriginalFilename(), null);
        return UploadJobView.from(record);
    }

    @Transactional(readOnly = true)
    public List<UploadJobView> listJobs() {
        return uploadJobRepository.findTop50ByOrderByCreatedAtDesc()
            .stream()
            .map(UploadJobView::from)
            .toList();
    }

    @Transactional
    public UploadJobView getJob(String jobId, boolean refresh) {
        UploadJobRecord record = uploadJobRepository.findByJobId(jobId)
            .orElseThrow(() -> new IllegalArgumentException("Job não encontrado"));

        if (refresh) {
            SandboxOrchestratorClient.SandboxOrchestratorJobResponse orchestratorResponse =
                sandboxOrchestratorClient.getJob(jobId);
            if (orchestratorResponse == null) {
                if (isTerminalStatus(record.getStatus())) {
                    record.setSummary("Job não encontrado no sandbox-orchestrator; exibindo último estado salvo localmente.");
                } else {
                    record.setStatus("FAILED");
                    record.setError("Job não encontrado no sandbox-orchestrator");
                }
            } else {
                populateFromOrchestrator(record, orchestratorResponse);
            }
            record.setUpdatedAt(Instant.now());
            uploadJobRepository.save(record);
        }

        return UploadJobView.from(record);
    }

    @Transactional
    public ResultZip downloadResultZip(String jobId) {
        UploadJobRecord record = uploadJobRepository.findByJobId(jobId)
            .orElseThrow(() -> new IllegalArgumentException("Job não encontrado"));

        String inlineZip = sanitizeBase64(record.getResultZipBase64());
        if (inlineZip == null) {
            SandboxOrchestratorClient.ResultZipDownload remoteZip = sandboxOrchestratorClient.getResultZip(jobId);
            if (remoteZip != null && remoteZip.bytes() != null && remoteZip.bytes().length > 0) {
                inlineZip = Base64.getEncoder().encodeToString(remoteZip.bytes());
                handleResultZip(record, inlineZip);
                Optional.ofNullable(remoteZip.filename()).ifPresent(record::setResultZipFilename);
                record.setUpdatedAt(Instant.now());
                uploadJobRepository.save(record);
                return new ResultZip(resolveZipFilename(record), remoteZip.bytes());
            }

            SandboxOrchestratorClient.SandboxOrchestratorJobResponse payload = sandboxOrchestratorClient.getJob(jobId);
            if (payload == null || sanitizeBase64(payload.resultZipBase64()) == null) {
                throw new IllegalStateException("ZIP ainda não está disponível para download");
            }
            inlineZip = payload.resultZipBase64();
            handleResultZip(record, inlineZip);
            Optional.ofNullable(payload.resultZipFilename()).ifPresent(record::setResultZipFilename);
            record.setUpdatedAt(Instant.now());
            uploadJobRepository.save(record);
        }

        byte[] bytes = decodeZip(inlineZip);
        return new ResultZip(resolveZipFilename(record), bytes);
    }

    private void populateFromOrchestrator(UploadJobRecord record, SandboxOrchestratorClient.SandboxOrchestratorJobResponse payload) {
        if (payload == null) {
            return;
        }

        Optional.ofNullable(payload.status()).ifPresent(record::setStatus);
        Optional.ofNullable(payload.summary()).ifPresent(record::setSummary);
        Optional.ofNullable(payload.error()).ifPresent(record::setError);
        Optional.ofNullable(payload.patch()).ifPresent(record::setPatch);
        String inlineZip = sanitizeBase64(payload.resultZipBase64());
        if (inlineZip != null) {
            handleResultZip(record, inlineZip);
        } else if (!isCompleted(payload.status())) {
            record.setResultZipReady(Boolean.FALSE);
            record.setResultZipBase64(null);
        }
        Optional.ofNullable(payload.resultZipFilename()).ifPresent(record::setResultZipFilename);
        Optional.ofNullable(payload.pullRequestUrl()).ifPresent(record::setPullRequestUrl);
        Optional.ofNullable(payload.promptTokens()).ifPresent(record::setPromptTokens);
        Optional.ofNullable(payload.cachedPromptTokens()).ifPresent(record::setCachedPromptTokens);
        Optional.ofNullable(payload.completionTokens()).ifPresent(record::setCompletionTokens);
        Optional.ofNullable(payload.totalTokens()).ifPresent(record::setTotalTokens);
        Optional.ofNullable(payload.cost()).ifPresent(record::setCost);
        enrichUsageFromPricing(record);
        if (payload.changedFiles() != null && !payload.changedFiles().isEmpty()) {
            record.setChangedFiles(String.join("\n", payload.changedFiles()));
        }
    }

    private void handleResultZip(UploadJobRecord record, String base64Zip) {
        if (base64Zip == null || base64Zip.isBlank()) {
            return;
        }
        record.setResultZipReady(Boolean.TRUE);
        long estimatedBytes = estimateBase64Bytes(base64Zip);
        if (shouldPersistInlineZip(estimatedBytes)) {
            record.setResultZipBase64(base64Zip);
        } else {
            if (record.getResultZipBase64() != null) {
                record.setResultZipBase64(null);
            }
            log.info(
                "ZIP do job {} tem {} bytes (limite inline {}), mantendo apenas referência remota",
                record.getJobId(),
                estimatedBytes,
                maxInlineZipBytes
            );
        }
    }

    private boolean shouldPersistInlineZip(long estimatedBytes) {
        return maxInlineZipBytes > 0 && estimatedBytes > 0 && estimatedBytes <= maxInlineZipBytes;
    }

    private long estimateBase64Bytes(String base64Zip) {
        if (base64Zip == null || base64Zip.isEmpty()) {
            return 0L;
        }
        long length = base64Zip.length();
        long padding = 0L;
        if (base64Zip.endsWith("==")) {
            padding = 2L;
        } else if (base64Zip.endsWith("=")) {
            padding = 1L;
        }
        return ((length / 4) * 3) - padding;
    }

    private byte[] decodeZip(String base64Zip) {
        try {
            return Base64.getDecoder().decode(base64Zip);
        } catch (IllegalArgumentException ex) {
            throw new IllegalStateException("ZIP retornado pelo sandbox está corrompido (base64 inválido)", ex);
        }
    }

    private String resolveZipFilename(UploadJobRecord record) {
        return Optional.ofNullable(record.getResultZipFilename())
            .filter(name -> !name.isBlank())
            .orElse(record.getJobId() + "-resultado.zip");
    }

    private String sanitizeBase64(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private boolean isTerminalStatus(String status) {
        if (status == null) {
            return false;
        }
        return "COMPLETED".equalsIgnoreCase(status) || "FAILED".equalsIgnoreCase(status);
    }

    private boolean isCompleted(String status) {
        return status != null && "COMPLETED".equalsIgnoreCase(status.trim());
    }

    private UploadedGitSshKey resolveGitSshPrivateKey(MultipartFile keyFile) {
        if (keyFile == null || keyFile.isEmpty()) {
            return null;
        }

        String filename = Optional.ofNullable(keyFile.getOriginalFilename())
            .filter(name -> !name.isBlank())
            .orElse("gitlab_id_key");

        try {
            return new UploadedGitSshKey(
                filename,
                Base64.getEncoder().encodeToString(keyFile.getBytes())
            );
        } catch (IOException e) {
            throw new IllegalStateException("Falha ao ler a chave privada SSH enviada", e);
        }
    }

    private UploadedGitlabPersonalAccessToken resolveGitlabPersonalAccessToken(MultipartFile tokenFile) {
        if (tokenFile == null || tokenFile.isEmpty()) {
            return null;
        }

        String filename = Optional.ofNullable(tokenFile.getOriginalFilename())
            .filter(name -> !name.isBlank())
            .orElse("gitlab_pat.key");

        try {
            return new UploadedGitlabPersonalAccessToken(
                filename,
                Base64.getEncoder().encodeToString(tokenFile.getBytes())
            );
        } catch (IOException e) {
            throw new IllegalStateException("Falha ao ler o token do GitLab enviado", e);
        }
    }

    private UploadedApplicationDefaultCredential resolveApplicationDefaultCredentials(MultipartFile credentialFile) {
        if (credentialFile == null || credentialFile.isEmpty()) {
            return null;
        }

        String filename = Optional.ofNullable(credentialFile.getOriginalFilename())
            .filter(name -> !name.isBlank())
            .orElse("application_default_credentials.json");

        try {
            return new UploadedApplicationDefaultCredential(
                filename,
                Base64.getEncoder().encodeToString(credentialFile.getBytes()),
                credentialFile.getContentType()
            );
        } catch (IOException e) {
            throw new IllegalStateException("Falha ao ler o arquivo de credenciais GCP enviado", e);
        }
    }

    private void enrichUsageFromPricing(UploadJobRecord record) {
        String model = normalizeModel(record.getModel());
        if (model == null) {
            return;
        }
        TokenCostBreakdown breakdown = tokenCostCalculator.calculate(
            model,
            record.getPromptTokens(),
            record.getCachedPromptTokens(),
            record.getCompletionTokens(),
            record.getTotalTokens()
        );
        if (breakdown == null) {
            return;
        }
        if (record.getPromptTokens() == null && breakdown.inputTokens() != null) {
            record.setPromptTokens(breakdown.inputTokens());
        }
        if (record.getCachedPromptTokens() == null && breakdown.cachedInputTokens() != null) {
            record.setCachedPromptTokens(breakdown.cachedInputTokens());
        }
        if (record.getCompletionTokens() == null && breakdown.outputTokens() != null) {
            record.setCompletionTokens(breakdown.outputTokens());
        }
        if (record.getTotalTokens() == null && breakdown.totalTokens() != null) {
            record.setTotalTokens(breakdown.totalTokens());
        }

        BigDecimal estimatedCost = breakdown.totalCost();
        if (estimatedCost != null && hasAnyTokenData(breakdown)) {
            if (record.getCost() == null || estimatedCost.compareTo(record.getCost()) != 0) {
                record.setCost(estimatedCost);
            }
        }
    }

    private boolean hasAnyTokenData(TokenCostBreakdown breakdown) {
        Integer prompt = breakdown.inputTokens();
        Integer cached = breakdown.cachedInputTokens();
        Integer completion = breakdown.outputTokens();
        Integer total = breakdown.totalTokens();
        return (prompt != null && prompt > 0)
            || (cached != null && cached > 0)
            || (completion != null && completion > 0)
            || (total != null && total > 0);
    }

    private String resolveDefaultModel(String uploadDefault, String codexDefault) {
        String sanitizedUpload = normalizeModel(uploadDefault);
        if (sanitizedUpload != null) {
            return sanitizedUpload;
        }
        return normalizeModel(codexDefault);
    }

    private String normalizeModel(String model) {
        if (model == null) {
            return null;
        }
        String trimmed = model.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    private List<UploadedProblemFile> resolveProblemFiles(List<MultipartFile> attachments) {
        if (attachments == null || attachments.isEmpty()) {
            return List.of();
        }

        List<UploadedProblemFile> files = new ArrayList<>();
        int unnamedIndex = 1;
        for (MultipartFile file : attachments) {
            if (file == null || file.isEmpty()) {
                continue;
            }

            String filename = Optional.ofNullable(file.getOriginalFilename())
                .filter(name -> !name.isBlank())
                .orElse("problema-" + unnamedIndex++ + ".txt");

            try {
                files.add(new UploadedProblemFile(
                    filename,
                    Base64.getEncoder().encodeToString(file.getBytes()),
                    file.getContentType()
                ));
            } catch (IOException e) {
                throw new IllegalStateException("Falha ao ler o arquivo enviado: " + filename, e);
            }
        }

        return files;
    }

    public record ResultZip(String filename, byte[] bytes) { }
}
