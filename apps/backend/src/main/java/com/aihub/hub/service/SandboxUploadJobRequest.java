package com.aihub.hub.service;

import java.util.List;

public record SandboxUploadJobRequest(
    String jobId,
    String taskDescription,
    String base64Zip,
    String zipName,
    String testCommand,
    String profile,
    String model,
    String repoUrl,
    String branch,
    List<UploadedProblemFile> problemFiles,
    UploadedApplicationDefaultCredential applicationDefaultCredentials,
    UploadedGitSshKey gitSshPrivateKey,
    UploadedGitlabPersonalAccessToken gitlabPersonalAccessToken
) {
}
