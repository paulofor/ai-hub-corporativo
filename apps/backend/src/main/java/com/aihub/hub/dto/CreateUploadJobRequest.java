package com.aihub.hub.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

public class CreateUploadJobRequest {

    @NotBlank
    private String taskDescription;

    @NotNull
    private MultipartFile sourceZip;

    private String testCommand;

    private String profile;

    private String model;

    private List<MultipartFile> problemFiles;

    private MultipartFile applicationDefaultCredentials;

    private MultipartFile gitSshPrivateKey;

    private MultipartFile gitlabPersonalAccessToken;

    public String getTaskDescription() {
        return taskDescription;
    }

    public void setTaskDescription(String taskDescription) {
        this.taskDescription = taskDescription;
    }

    public MultipartFile getSourceZip() {
        return sourceZip;
    }

    public void setSourceZip(MultipartFile sourceZip) {
        this.sourceZip = sourceZip;
    }

    public String getTestCommand() {
        return testCommand;
    }

    public void setTestCommand(String testCommand) {
        this.testCommand = testCommand;
    }

    public String getProfile() {
        return profile;
    }

    public void setProfile(String profile) {
        this.profile = profile;
    }

    public String getModel() {
        return model;
    }

    public void setModel(String model) {
        this.model = model;
    }

    public List<MultipartFile> getProblemFiles() {
        return problemFiles;
    }

    public void setProblemFiles(List<MultipartFile> problemFiles) {
        this.problemFiles = problemFiles;
    }

    public MultipartFile getApplicationDefaultCredentials() {
        return applicationDefaultCredentials;
    }

    public void setApplicationDefaultCredentials(MultipartFile applicationDefaultCredentials) {
        this.applicationDefaultCredentials = applicationDefaultCredentials;
    }

    public MultipartFile getGitSshPrivateKey() {
        return gitSshPrivateKey;
    }

    public void setGitSshPrivateKey(MultipartFile gitSshPrivateKey) {
        this.gitSshPrivateKey = gitSshPrivateKey;
    }

    public MultipartFile getGitlabPersonalAccessToken() {
        return gitlabPersonalAccessToken;
    }

    public void setGitlabPersonalAccessToken(MultipartFile gitlabPersonalAccessToken) {
        this.gitlabPersonalAccessToken = gitlabPersonalAccessToken;
    }
}
