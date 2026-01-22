package com.aihub.hub.web;

import com.aihub.hub.dto.CreateUploadJobRequest;
import com.aihub.hub.dto.UploadJobView;
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
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/upload-jobs")
public class SandboxUploadController {

    private final SandboxUploadService sandboxUploadService;

    public SandboxUploadController(SandboxUploadService sandboxUploadService) {
        this.sandboxUploadService = sandboxUploadService;
    }

    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<UploadJobView> createJob(
        @RequestHeader(value = "X-Role", defaultValue = "viewer") String role,
        @RequestHeader(value = "X-User", defaultValue = "unknown") String actor,
        @Valid @ModelAttribute CreateUploadJobRequest request
    ) {
        assertOwner(role);
        return ResponseEntity.ok(sandboxUploadService.createJob(actor, request));
    }

    @GetMapping
    public ResponseEntity<List<UploadJobView>> listJobs() {
        return ResponseEntity.ok(sandboxUploadService.listJobs());
    }

    @GetMapping("/{jobId}")
    public ResponseEntity<UploadJobView> getJob(@PathVariable String jobId,
                                                @RequestParam(value = "refresh", required = false, defaultValue = "false") boolean refresh) {
        return ResponseEntity.ok(sandboxUploadService.getJob(jobId, refresh));
    }

    private void assertOwner(String role) {
        if (!"owner".equalsIgnoreCase(role)) {
            throw new IllegalStateException("Ação requer confirmação de um owner");
        }
    }
}
