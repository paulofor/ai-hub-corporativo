package com.aihub.hub.service;

public record UploadedProblemFile(
    String filename,
    String base64,
    String contentType
) {
}
