import express, { Request, Response } from 'express';
import morgan from 'morgan';
import { spawnSync } from 'node:child_process';

import { SandboxJobProcessor } from './jobProcessor.js';
import { JobProcessor, SandboxJob, SandboxProfile, UploadedProblemFile } from './types.js';

interface AppOptions {
  jobRegistry?: Map<string, SandboxJob>;
  processor?: JobProcessor;
}

function validateString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseProblemFiles(raw: unknown): UploadedProblemFile[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const items = raw as Array<Record<string, unknown>>;
  const files: UploadedProblemFile[] = [];
  items.forEach((item, index) => {
    const base64 = validateString(item?.base64);
    if (!base64) {
      return;
    }
    const filename = validateString(item?.filename) ?? `problema-${index + 1}.txt`;
    const contentType = validateString(item?.contentType);
    files.push({ base64, filename, contentType: contentType ?? undefined });
  });

  return files;
}

export function createApp(options: AppOptions = {}) {
  const jobRegistry = options.jobRegistry ?? new Map<string, SandboxJob>();
  const processor =
    options.processor ?? new SandboxJobProcessor(process.env.OPENAI_API_KEY, process.env.CIFIX_MODEL);

  const normalizeProfile = (value?: string): SandboxProfile => {
    if (!value) {
      return 'STANDARD';
    }
    const normalized = value.trim().toUpperCase();
    return normalized === 'ECONOMY' ? 'ECONOMY' : 'STANDARD';
  };

  const app = express();
  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
  }
  const jsonLimit = process.env.JSON_BODY_LIMIT ?? '15mb';
  app.use(express.json({ limit: jsonLimit }));

  const healthcheckPythonInfo = () => {
    const pythonPath = spawnSync('which', ['python3'], { encoding: 'utf-8' });
    const pipVersion = spawnSync('pip3', ['--version'], { encoding: 'utf-8' });

    const python = pythonPath.status === 0 ? pythonPath.stdout.trim() : undefined;
    const pip = pipVersion.status === 0 ? pipVersion.stdout.trim() : undefined;

    if (python) {
      console.log(`Sandbox orchestrator healthcheck: python3 disponível em ${python}`);
    } else {
      console.warn('Sandbox orchestrator healthcheck: python3 não encontrado');
    }

    if (pip) {
      console.log(`Sandbox orchestrator healthcheck: pip3 detectado (${pip})`);
    }

    return { python, pip };
  };

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', python: healthcheckPythonInfo() });
  });

  app.post('/jobs', async (req: Request, res: Response) => {
    const jobId = validateString(req.body?.jobId);
    const repoUrl = validateString(req.body?.repoUrl);
    const repoSlug = validateString(req.body?.repoSlug);
    const branch = validateString(req.body?.branch);
    const taskDescription = validateString(req.body?.taskDescription ?? req.body?.task);
    const commitHash = validateString(req.body?.commit);
    const testCommand = validateString(req.body?.testCommand);
    const model = validateString(req.body?.model);
    const profile = normalizeProfile(validateString(req.body?.profile));
    const uploadedZipBase64 =
      validateString(req.body?.uploadedZip?.base64) ??
      validateString(req.body?.sourceZipBase64) ??
      validateString(req.body?.zipBase64);
    const uploadedZipName =
      validateString(req.body?.uploadedZip?.filename) ??
      validateString(req.body?.sourceZipName) ??
      validateString(req.body?.zipName);

    const problemFiles = parseProblemFiles(req.body?.problemFiles);

    const isUpload = Boolean(uploadedZipBase64);
    const resolvedBranch = branch ?? (isUpload ? 'upload' : undefined);

    if (!jobId || !taskDescription || (!isUpload && ((!repoUrl && !repoSlug) || !resolvedBranch))) {
      return res
        .status(400)
        .json({ error: 'jobId, taskDescription e (repoSlug/repoUrl + branch ou uploadedZip) são obrigatórios' });
    }

    if (!resolvedBranch) {
      return res.status(400).json({ error: 'branch é obrigatória quando não há zip enviado' });
    }

    const existing = jobRegistry.get(jobId);
    if (existing) {
      console.log(`Sandbox orchestrator: received duplicate job ${jobId}, returning cached status ${existing.status}`);
      return res.json(existing);
    }

    const sourceLabel = isUpload ? `upload ${uploadedZipName ?? 'fonte.zip'}` : repoSlug ?? repoUrl;
    const modelLabel = model ? `, modelo ${model}` : '';
    console.log(
      `Sandbox orchestrator: registrando job ${jobId} para ${sourceLabel} na branch ${resolvedBranch} (perfil ${profile}${modelLabel})`,
    );

    const now = new Date().toISOString();
    const job: SandboxJob = {
      jobId,
      repoSlug: repoSlug,
      repoUrl: repoUrl ?? (repoSlug ? `https://github.com/${repoSlug}.git` : `upload://${jobId}`),
      branch: resolvedBranch,
      taskDescription,
      commitHash,
      testCommand,
      profile,
      model: model ?? undefined,
      uploadedZip: isUpload ? { base64: uploadedZipBase64!, filename: uploadedZipName ?? undefined } : undefined,
      problemFiles: problemFiles.length ? problemFiles : undefined,
      status: 'PENDING',
      logs: [],
      createdAt: now,
      updatedAt: now,
    };

    jobRegistry.set(jobId, job);

    processor
      .process(job)
      .catch((err) => {
        job.status = 'FAILED';
        job.error = err instanceof Error ? err.message : String(err);
        job.updatedAt = new Date().toISOString();
      })
      .finally(() => {
        jobRegistry.set(jobId, job);
      });

    res.status(201).json(job);
  });

  app.get('/jobs/:id', (req: Request, res: Response) => {
    const job = jobRegistry.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'job not found' });
    }
    res.json(job);
  });

  app.use((err: Error, _req: Request, res: Response, _next: () => void) => {
    console.error('Unexpected error handling request', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
