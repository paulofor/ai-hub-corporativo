export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface UploadJob {
  jobId: string;
  status: JobStatus;
  summary?: string;
  error?: string;
  changedFiles?: string[];
  patch?: string;
  resultZipBase64?: string;
  resultZipFilename?: string;
  resultZipReady?: boolean;
  title?: string;
  pullRequestUrl?: string;
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  lastSyncedAt?: number;
}

const storedJobsKey = 'aihub.uploadJobs';
export const MAX_STORED_UPLOAD_JOBS = 10;
const maxTitleLength = 20;

interface StoredJobPayload {
  jobId: string;
  title?: string;
  status?: JobStatus;
  summary?: string;
  error?: string;
  changedFiles?: string[];
  patch?: string;
  resultZipFilename?: string;
  resultZipReady?: boolean;
  pullRequestUrl?: string;
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  lastSyncedAt?: number;
}

const jobStatuses: JobStatus[] = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'];

const parseJobStatus = (value: unknown): JobStatus => {
  if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    if (jobStatuses.includes(normalized as JobStatus)) {
      return normalized as JobStatus;
    }
  }
  return 'PENDING';
};

const parseString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const parseStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const sanitized = value
    .map((item) => parseString(item))
    .filter((item): item is string => Boolean(item));
  return sanitized.length > 0 ? sanitized : undefined;
};

const getStorage = () => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }
  return window.localStorage;
};

export const buildJobTitle = (task: string) => {
  const normalized = task.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Sem título';
  }
  if (normalized.length <= maxTitleLength) {
    return normalized;
  }
  return normalized.slice(0, maxTitleLength).trimEnd();
};

const sanitizeJobForStorage = (job: UploadJob): StoredJobPayload => ({
  jobId: job.jobId,
  title: job.title ?? 'Sem título',
  status: job.status,
  summary: job.summary,
  error: job.error,
  changedFiles: job.changedFiles,
  patch: job.patch,
  resultZipFilename: job.resultZipFilename,
  resultZipReady: Boolean(job.resultZipBase64 || job.resultZipReady),
  pullRequestUrl: job.pullRequestUrl,
  promptTokens: job.promptTokens,
  cachedPromptTokens: job.cachedPromptTokens,
  completionTokens: job.completionTokens,
  totalTokens: job.totalTokens,
  cost: job.cost,
  lastSyncedAt: job.lastSyncedAt ?? Date.now()
});

const reviveStoredJob = (job: StoredJobPayload): UploadJob | null => {
  if (!job || typeof job.jobId !== 'string') {
    return null;
  }
  return {
    jobId: job.jobId,
    title: job.title,
    status: job.status ?? 'PENDING',
    summary: job.summary,
    error: job.error,
    changedFiles: parseStringArray(job.changedFiles) ?? job.changedFiles,
    patch: job.patch,
    resultZipFilename: job.resultZipFilename,
    resultZipReady: Boolean(job.resultZipReady),
    pullRequestUrl: job.pullRequestUrl,
    promptTokens: job.promptTokens,
    cachedPromptTokens: job.cachedPromptTokens,
    completionTokens: job.completionTokens,
    totalTokens: job.totalTokens,
    cost: job.cost,
    lastSyncedAt: job.lastSyncedAt
  };
};

export const readStoredJobs = (): UploadJob[] => {
  try {
    const storage = getStorage();
    if (!storage) {
      return [];
    }
    const raw = storage.getItem(storedJobsKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => reviveStoredJob(item))
      .filter((job): job is UploadJob => Boolean(job))
      .slice(0, MAX_STORED_UPLOAD_JOBS);
  } catch (err) {
    console.warn('Falha ao carregar jobs salvos', err);
    return [];
  }
};

export const writeStoredJobs = (jobs: UploadJob[]) => {
  try {
    const storage = getStorage();
    if (!storage) {
      return;
    }
    const payload = jobs
      .filter((job) => Boolean(job.jobId))
      .map((job) => sanitizeJobForStorage(job))
      .slice(0, MAX_STORED_UPLOAD_JOBS);
    storage.setItem(storedJobsKey, JSON.stringify(payload));
  } catch (err) {
    console.warn('Falha ao salvar jobs', err);
  }
};

export const parseUploadJob = (payload: unknown): UploadJob => {
  const data = (payload ?? {}) as Record<string, unknown>;
  const resultZipBase64 = parseString(data.resultZipBase64);
  const resultZipFilename = parseString(data.resultZipFilename);

  return {
    jobId: parseString(data.jobId) ?? '',
    status: parseJobStatus(data.status),
    summary: parseString(data.summary),
    error: parseString(data.error),
    changedFiles: parseStringArray(data.changedFiles),
    patch: parseString(data.patch),
    resultZipBase64,
    resultZipFilename,
    resultZipReady: Boolean(resultZipBase64),
    title: parseString(data.title),
    pullRequestUrl: parseString(data.pullRequestUrl),
    promptTokens: parseNumber(data.promptTokens),
    cachedPromptTokens: parseNumber(data.cachedPromptTokens),
    completionTokens: parseNumber(data.completionTokens),
    totalTokens: parseNumber(data.totalTokens),
    cost: parseNumber(data.cost),
    lastSyncedAt: Date.now()
  };
};

export const downloadUploadJobZip = (job: UploadJob) => {
  if (!job.resultZipBase64) {
    throw new Error('ZIP indisponível para este job.');
  }
  const binaryString = atob(job.resultZipBase64);
  const length = binaryString.length;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = job.resultZipFilename || `${job.jobId}-resultado.zip`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const statusClasses: Record<JobStatus, string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  RUNNING: 'bg-sky-100 text-sky-800',
  COMPLETED: 'bg-emerald-100 text-emerald-800',
  FAILED: 'bg-rose-100 text-rose-800'
};

export const getUploadJobStatusClassName = (status: JobStatus) =>
  statusClasses[status] ?? 'bg-slate-100 text-slate-700';

export const resolveUploadJobTitle = (jobId: string, ...candidates: (string | undefined)[]) => {
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) {
      return candidate.trim();
    }
  }
  if (!jobId) {
    return 'Sem título';
  }
  return `Job ${jobId.slice(0, 8)}`;
};
