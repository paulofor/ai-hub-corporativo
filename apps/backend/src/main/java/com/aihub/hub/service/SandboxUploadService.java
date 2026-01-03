package com.aihub.hub.service;

import com.aihub.hub.dto.CreateUploadJobRequest;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class SandboxUploadService {

    private final SandboxOrchestratorClient sandboxOrchestratorClient;
    private final AuditService auditService;

    public SandboxUploadService(SandboxOrchestratorClient sandboxOrchestratorClient, AuditService auditService) {
        this.sandboxOrchestratorClient = sandboxOrchestratorClient;
        this.auditService = auditService;
    }

    public SandboxOrchestratorClient.SandboxOrchestratorJobResponse createJob(String actor, CreateUploadJobRequest request) {
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

        SandboxOrchestratorClient.SandboxOrchestratorJobResponse response =
            sandboxOrchestratorClient.createUploadJob(payload);

        auditService.record(actor, "upload_job_created", sourceZip.getOriginalFilename(), null);
        return response;
    }

    public SandboxOrchestratorClient.SandboxOrchestratorJobResponse getJob(String jobId) {
        return sandboxOrchestratorClient.getJob(jobId);
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
