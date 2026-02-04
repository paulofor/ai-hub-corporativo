export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type SandboxProfile = 'STANDARD' | 'ECONOMY';

export interface UploadedZip {
  base64: string;
  filename?: string;
}

export interface UploadedProblemFile {
  base64: string;
  filename: string;
  contentType?: string;
}

export interface UploadedApplicationDefaultCredential {
  base64: string;
  filename?: string;
  contentType?: string;
}

export interface UploadedGitSshPrivateKey {
  base64: string;
  filename?: string;
}

export interface UploadedGitlabPersonalAccessToken {
  base64: string;
  filename?: string;
}

export interface SandboxJob {
  jobId: string;
  repoSlug?: string;
  repoUrl: string;
  branch: string;
  taskDescription: string;
  testCommand?: string;
  commitHash?: string;
  profile?: SandboxProfile;
  model?: string;
  uploadedZip?: UploadedZip;
  applicationDefaultCredentials?: UploadedApplicationDefaultCredential;
  gitSshPrivateKey?: UploadedGitSshPrivateKey;
  gitlabPersonalAccessToken?: UploadedGitlabPersonalAccessToken;
  problemFiles?: UploadedProblemFile[];
  status: JobStatus;
  summary?: string;
  changedFiles?: string[];
  patch?: string;
  pullRequestUrl?: string;
  error?: string;
  sandboxPath?: string;
  gcpCredentialsPath?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  resultZipBase64?: string;
  resultZipFilename?: string;
  logs: string[];
  createdAt: string;
  updatedAt: string;
  gitSshKeyPath?: string;
  gitlabPatPath?: string;
  gitlabPatValue?: string;
}


export interface JobProcessor {
  process(job: SandboxJob): Promise<void>;
}
