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

    public SandboxUploadService(SandboxOrchestratorClient sandboxOrchestratorClient,
                                AuditService auditService,
                                UploadJobRepository uploadJobRepository,
                                @Value("${hub.upload-jobs.max-inline-zip-bytes:8388608}") long maxInlineZipBytes) {
        this.sandboxOrchestratorClient = sandboxOrchestratorClient;
        this.auditService = auditService;
        this.uploadJobRepository = uploadJobRepository;
        this.maxInlineZipBytes = Math.max(0L, maxInlineZipBytes);
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

        SandboxUploadJobRequest payload = new SandboxUploadJobRequest(
            jobId,
            request.getTaskDescription(),
            base64,
            sourceZip.getOriginalFilename(),
            request.getTestCommand(),
            request.getProfile(),
            request.getModel(),
            "upload://" + jobId,
            "upload",
            problemFiles,
            applicationDefaultCredentials
        );

        UploadJobRecord record = new UploadJobRecord();
        record.setJobId(jobId);
        record.setTaskDescription(request.getTaskDescription());
        record.setTestCommand(request.getTestCommand());
        record.setProfile(request.getProfile());
        record.setModel(request.getModel());
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
            populateFromOrchestrator(record, orchestratorResponse);
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

    private boolean isCompleted(String status) {
        return status != null && "COMPLETED".equalsIgnoreCase(status.trim());
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
