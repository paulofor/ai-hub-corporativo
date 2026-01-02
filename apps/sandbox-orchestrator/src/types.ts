export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
export type SandboxProfile = 'STANDARD' | 'ECONOMY';

export interface UploadedZip {
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
  status: JobStatus;
  summary?: string;
  changedFiles?: string[];
  patch?: string;
  pullRequestUrl?: string;
  error?: string;
  sandboxPath?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  logs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface JobProcessor {
  process(job: SandboxJob): Promise<void>;
}
