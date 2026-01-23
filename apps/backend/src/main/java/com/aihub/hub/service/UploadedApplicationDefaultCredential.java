package com.aihub.hub.service;

public record UploadedApplicationDefaultCredential(
    String filename,
    String base64,
    String contentType
) {
}
