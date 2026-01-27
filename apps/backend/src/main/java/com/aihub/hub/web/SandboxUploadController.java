package com.aihub.hub.web;

import com.aihub.hub.dto.CreateUploadJobRequest;
import com.aihub.hub.dto.UploadJobView;
import com.aihub.hub.service.SandboxUploadService;
import jakarta.validation.Valid;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
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

import java.nio.charset.StandardCharsets;
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

    @GetMapping("/{jobId}/result-zip")
    public ResponseEntity<ByteArrayResource> downloadResultZip(@PathVariable String jobId) {
        SandboxUploadService.ResultZip zip = sandboxUploadService.downloadResultZip(jobId);
        ByteArrayResource resource = new ByteArrayResource(zip.bytes());
        ContentDisposition disposition = ContentDisposition.attachment()
            .filename(zip.filename(), StandardCharsets.UTF_8)
            .build();
        return ResponseEntity.ok()
            .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
            .contentType(MediaType.APPLICATION_OCTET_STREAM)
            .contentLength(zip.bytes().length)
            .body(resource);
    }

    private void assertOwner(String role) {
        if (!"owner".equalsIgnoreCase(role)) {
            throw new IllegalStateException("Ação requer confirmação de um owner");
        }
    }
}
