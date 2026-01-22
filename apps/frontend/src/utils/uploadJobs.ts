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
  taskDescription?: string;
  pullRequestUrl?: string;
  promptTokens?: number;
  cachedPromptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  createdAt?: number;
  updatedAt?: number;
  lastSyncedAt?: number;
}

const jobStatuses: JobStatus[] = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED'];
const maxTitleLength = 20;

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

const parseDate = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return undefined;
    }
    const parsed = Date.parse(normalized);
    return Number.isNaN(parsed) ? undefined : parsed;
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

export const parseUploadJob = (payload: unknown): UploadJob => {
  const data = (payload ?? {}) as Record<string, unknown>;
  const resultZipBase64 = parseString(data.resultZipBase64);
  const resultZipFilename = parseString(data.resultZipFilename);
  const taskDescription = parseString(data.taskDescription);
  const updatedAt = parseDate(data.updatedAt);

  return {
    jobId: parseString(data.jobId) ?? '',
    title: parseString(data.title) ?? (taskDescription ? buildJobTitle(taskDescription) : undefined),
    taskDescription,
    status: parseJobStatus(data.status),
    summary: parseString(data.summary),
    error: parseString(data.error),
    changedFiles: parseStringArray(data.changedFiles),
    patch: parseString(data.patch),
    resultZipBase64,
    resultZipFilename,
    resultZipReady: Boolean(resultZipBase64 || data.resultZipReady),
    pullRequestUrl: parseString(data.pullRequestUrl),
    promptTokens: parseNumber(data.promptTokens),
    cachedPromptTokens: parseNumber(data.cachedPromptTokens),
    completionTokens: parseNumber(data.completionTokens),
    totalTokens: parseNumber(data.totalTokens),
    cost: parseNumber(data.cost),
    createdAt: parseDate(data.createdAt),
    updatedAt,
    lastSyncedAt: updatedAt ?? Date.now()
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
