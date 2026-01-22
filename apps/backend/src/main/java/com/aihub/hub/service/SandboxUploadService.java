package com.aihub.hub.service;

import com.aihub.hub.domain.UploadJobRecord;
import com.aihub.hub.dto.CreateUploadJobRequest;
import com.aihub.hub.dto.UploadJobView;
import com.aihub.hub.repository.UploadJobRepository;
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

    private final SandboxOrchestratorClient sandboxOrchestratorClient;
    private final AuditService auditService;
    private final UploadJobRepository uploadJobRepository;

    public SandboxUploadService(SandboxOrchestratorClient sandboxOrchestratorClient,
                                AuditService auditService,
                                UploadJobRepository uploadJobRepository) {
        this.sandboxOrchestratorClient = sandboxOrchestratorClient;
        this.auditService = auditService;
        this.uploadJobRepository = uploadJobRepository;
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
            problemFiles
        );

        UploadJobRecord record = new UploadJobRecord();
        record.setJobId(jobId);
        record.setTaskDescription(request.getTaskDescription());
        record.setTestCommand(request.getTestCommand());
        record.setProfile(request.getProfile());
        record.setModel(request.getModel());
        record.setZipName(sourceZip.getOriginalFilename());
        record.setStatus("PENDING");
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

    private void populateFromOrchestrator(UploadJobRecord record, SandboxOrchestratorClient.SandboxOrchestratorJobResponse payload) {
        if (payload == null) {
            return;
        }

        Optional.ofNullable(payload.status()).ifPresent(record::setStatus);
        Optional.ofNullable(payload.summary()).ifPresent(record::setSummary);
        Optional.ofNullable(payload.error()).ifPresent(record::setError);
        Optional.ofNullable(payload.patch()).ifPresent(record::setPatch);
        Optional.ofNullable(payload.resultZipBase64()).ifPresent(record::setResultZipBase64);
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
}
