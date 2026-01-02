package com.aihub.hub.web;

import com.aihub.hub.dto.CreateUploadJobRequest;
import com.aihub.hub.service.SandboxOrchestratorClient;
import com.aihub.hub.service.SandboxUploadService;
import jakarta.validation.Valid;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.ModelAttribute;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/upload-jobs")
public class SandboxUploadController {

    private final SandboxUploadService sandboxUploadService;

    public SandboxUploadController(SandboxUploadService sandboxUploadService) {
        this.sandboxUploadService = sandboxUploadService;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<SandboxOrchestratorClient.SandboxOrchestratorJobResponse> createJob(
        @RequestHeader(value = "X-Role", defaultValue = "viewer") String role,
        @RequestHeader(value = "X-User", defaultValue = "unknown") String actor,
        @Valid @ModelAttribute CreateUploadJobRequest request
    ) {
        assertOwner(role);
        return ResponseEntity.ok(sandboxUploadService.createJob(actor, request));
    }

    @GetMapping("/{jobId}")
    public ResponseEntity<SandboxOrchestratorClient.SandboxOrchestratorJobResponse> getJob(@PathVariable String jobId) {
        return ResponseEntity.ok(sandboxUploadService.getJob(jobId));
    }

    private void assertOwner(String role) {
        if (!"owner".equalsIgnoreCase(role)) {
            throw new IllegalStateException("Ação requer confirmação de um owner");
        }
    }
}
