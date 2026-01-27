package com.aihub.hub.service;

public record UploadedGitSshKey(
    String filename,
    String base64
) {
}
