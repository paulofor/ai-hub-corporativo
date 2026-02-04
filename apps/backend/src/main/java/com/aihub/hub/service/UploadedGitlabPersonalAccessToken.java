package com.aihub.hub.service;

public record UploadedGitlabPersonalAccessToken(
    String filename,
    String base64
) {
}
