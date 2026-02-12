import express, { Request, Response } from 'express';
import morgan from 'morgan';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { SandboxJobProcessor } from './jobProcessor.js';
import { JobProcessor, SandboxJob, SandboxProfile, UploadedApplicationDefaultCredential, UploadedGitSshPrivateKey, UploadedGitlabPersonalAccessToken, UploadedProblemFile } from './types.js';

interface AppOptions {
  jobRegistry?: Map<string, SandboxJob>;
  processor?: JobProcessor;
}

interface ApiKeyResolution {
  key?: string;
  candidates: string[];
}

function logVolumeMappings() {
  const tokenHostDir = validateString(process.env.OPENAI_TOKEN_HOST_DIR) ?? './infra/openai-token';
  const tokenContainerDir = '/run/secrets/openai-token';
  const sandboxWorkdirHost = validateString(process.env.SANDBOX_WORKDIR_HOST) ?? './src';
  const sandboxWorkdir = validateString(process.env.SANDBOX_WORKDIR) ?? '/workspace/ai-hub-corporativo/src';

  console.log(
    `Sandbox orchestrator: mapeamento OPENAI_TOKEN_HOST_DIR ${tokenHostDir} (host) -> ${tokenContainerDir} (container)`,
  );
  console.log(
    `Sandbox orchestrator: mapeamento SANDBOX_WORKDIR_HOST ${sandboxWorkdirHost} (host) -> SANDBOX_WORKDIR ${sandboxWorkdir} (container)`,
  );
}

function validateString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readKeyFile(path?: string): string | undefined {
  if (!path) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(path, 'utf-8').trim();
    return content || undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!['ENOENT', 'EACCES', 'EPERM'].includes(code ?? '')) {
      console.warn(`Sandbox orchestrator: falha ao ler chave OpenAI em ${path}:`, err);
    }
    return undefined;
  }
}

function resolveOpenAiApiKey(): ApiKeyResolution {
  const candidates: string[] = [];

  const envKey = validateString(process.env.OPENAI_API_KEY);
  if (envKey) {
    console.log('Sandbox orchestrator: OPENAI_API_KEY encontrada no ambiente (OPENAI_API_KEY).');
    return { key: envKey, candidates };
  }

  const fileCandidates = [
    validateString(process.env.OPENAI_API_KEY_FILE),
    '/run/secrets/openai-token/openai_api_key',
    '/run/secrets/openai-token/open_api_key',
    '/root/infra/openai-token/openai_api_key',
    '/root/infra/openai-token/open_api_key',
  ].filter(Boolean) as string[];

  if (fileCandidates.length) {
    const directories = Array.from(
      new Set(fileCandidates.map((candidate) => candidate.split('/').slice(0, -1).join('/'))),
    );
    console.log(
      `Sandbox orchestrator: buscando OPENAI_API_KEY nos arquivos: ${fileCandidates.join(', ')} (diretórios: ${directories.join(
        ', ',
      )})`,
    );
  } else {
    console.log('Sandbox orchestrator: nenhum caminho configurado para buscar OPENAI_API_KEY em arquivo.');
  }

  for (const candidate of fileCandidates) {
    candidates.push(candidate);
    const key = readKeyFile(candidate);
    if (key) {
      console.log(`Sandbox orchestrator: OPENAI_API_KEY carregada do arquivo ${candidate}`);
      return { key, candidates };
    }
  }

  return { candidates };
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

function parseApplicationDefaultCredentials(raw: unknown): UploadedApplicationDefaultCredential | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const payload = raw as Record<string, unknown>;
  const base64 = validateString(payload["base64"]);
  if (!base64) {
    return undefined;
  }

  const filename = validateString(payload["filename"]);
  const contentType = validateString(payload["contentType"]);
  return { base64, filename: filename ?? undefined, contentType: contentType ?? undefined };
}

function parseGitSshPrivateKey(raw: unknown): UploadedGitSshPrivateKey | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const payload = raw as Record<string, unknown>;
  const base64 = validateString(payload['base64']);
  if (!base64) {
    return undefined;
  }

  const filename = validateString(payload['filename']);
  return { base64, filename: filename ?? undefined };
}

function parseGitlabPersonalAccessToken(raw: unknown): UploadedGitlabPersonalAccessToken | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const payload = raw as Record<string, unknown>;
  const base64 = validateString(payload['base64']);
  if (!base64) {
    return undefined;
  }

  const filename = validateString(payload['filename']);
  return { base64, filename: filename ?? undefined };
}

function buildJobResponse(job: SandboxJob) {
  const {
    uploadedZip,
    applicationDefaultCredentials,
    gitSshPrivateKey,
    gitlabPersonalAccessToken,
    problemFiles,
    gitlabPatValue,
    resultZipBase64,
    ...publicJob
  } = job;

  return {
    ...publicJob,
    resultZipReady: Boolean(resultZipBase64),
    hasUploadedZip: Boolean(uploadedZip),
    problemFilesCount: problemFiles?.length ?? 0,
    hasApplicationDefaultCredentials: Boolean(applicationDefaultCredentials),
    hasGitSshPrivateKey: Boolean(gitSshPrivateKey),
    hasGitlabPersonalAccessToken: Boolean(gitlabPersonalAccessToken),
  };
}

export function createApp(options: AppOptions = {}) {
  const jobRegistry = options.jobRegistry ?? new Map<string, SandboxJob>();
  logVolumeMappings();
  const { key: apiKey, candidates: keyCandidates } = resolveOpenAiApiKey();
  if (!apiKey) {
    const candidatesLabel = keyCandidates.length ? keyCandidates.join(', ') : '<nenhum caminho verificado>';
    console.warn(
      `Sandbox orchestrator: OPENAI_API_KEY não configurada; os jobs não conseguirão chamar o modelo (caminhos verificados: ${candidatesLabel}).`,
    );
  }
  const processor = options.processor ?? new SandboxJobProcessor(apiKey, process.env.CIFIX_MODEL);

  const normalizeProfile = (value?: string): SandboxProfile => {
    if (!value) {
      return 'STANDARD';
    }
    const normalized = value.trim().toUpperCase();
    return normalized === 'ECONOMY' ? 'ECONOMY' : 'STANDARD';
  };
  const jobStaleTimeoutMs = (() => {
    const raw = Number(process.env.JOB_STALE_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) {
      return raw;
    }
    return 6 * 60 * 60 * 1000;
  })();

  const resolveTimestamp = (value?: string): number | null => {
    if (!value) {
      return null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  };

  const markStaleJobIfNeeded = (job: SandboxJob) => {
    if (job.status !== 'RUNNING') {
      return;
    }
    const updatedAt = resolveTimestamp(job.updatedAt);
    if (!updatedAt) {
      return;
    }
    const now = Date.now();
    if (now - updatedAt <= jobStaleTimeoutMs) {
      return;
    }
    job.status = 'FAILED';
    job.error = 'Job ficou em execução por tempo demais e foi marcado como falho.';
    job.updatedAt = new Date(now).toISOString();
    job.logs.push(`[${job.updatedAt}] job expirou após ${Math.round(jobStaleTimeoutMs / 60000)} minutos`);
  };

  const app = express();
  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('combined'));
  }
  const jsonLimit = process.env.JSON_BODY_LIMIT ?? '250mb';
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
    const applicationDefaultCredentials = parseApplicationDefaultCredentials(req.body?.applicationDefaultCredentials);
    const gitSshPrivateKey = parseGitSshPrivateKey(req.body?.gitSshPrivateKey);
    const gitlabPersonalAccessToken = parseGitlabPersonalAccessToken(req.body?.gitlabPersonalAccessToken);

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
      return res.json(buildJobResponse(existing));
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
      applicationDefaultCredentials: applicationDefaultCredentials ?? undefined,
      gitSshPrivateKey: gitSshPrivateKey ?? undefined,
      gitlabPersonalAccessToken: gitlabPersonalAccessToken ?? undefined,
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

    res.status(201).json(buildJobResponse(job));
  });

  app.get('/jobs/:id', (req: Request, res: Response) => {
    const job = jobRegistry.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'job not found' });
    }
    markStaleJobIfNeeded(job);
    res.json(buildJobResponse(job));
  });

  app.get('/jobs/:id/result-zip', (req: Request, res: Response) => {
    const job = jobRegistry.get(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'job not found' });
    }

    const base64 = validateString(job.resultZipBase64);
    if (!base64) {
      return res.status(409).json({ error: 'result zip not available' });
    }

    const buffer = Buffer.from(base64, 'base64');
    const filename = validateString(job.resultZipFilename) ?? `${job.jobId}-resultado.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(buffer);
  });

  app.use((err: Error & { type?: string; limit?: number }, _req: Request, res: Response, _next: () => void) => {
    if (err?.type === 'entity.too.large') {
      console.warn('Sandbox orchestrator: payload excedeu o limite configurado', err);
      return res.status(413).json({ error: 'payload_too_large', limit: jsonLimit });
    }
    console.error('Unexpected error handling request', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
