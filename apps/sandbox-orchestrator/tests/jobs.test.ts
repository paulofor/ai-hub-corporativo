import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import AdmZip from 'adm-zip';
import path from 'node:path';
import request from 'supertest';

import { createApp } from '../src/server.js';
import { SandboxJobProcessor } from '../src/jobProcessor.js';
import { JobProcessor, SandboxJob } from '../src/types.js';

class StubProcessor implements JobProcessor {
  async process(job: SandboxJob): Promise<void> {
    job.status = 'COMPLETED';
    job.summary = 'ok';
    job.changedFiles = ['README.md'];
    job.updatedAt = new Date().toISOString();
  }
}

async function withGitlabSettingsBackup(action: (settingsPath: string) => Promise<void>) {
  const settingsPath = path.join('/root', '.m2', 'settings.xml');
  let backup: Buffer | null = null;
  try {
    backup = await fs.readFile(settingsPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      throw err;
    }
  }

  try {
    await action(settingsPath);
  } finally {
    if (backup) {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true });
      await fs.writeFile(settingsPath, backup, { mode: 0o600 });
    } else {
      await fs.rm(settingsPath, { force: true });
    }
  }
}

test('reports python availability on healthcheck', async () => {
  const app = createApp({ processor: new StubProcessor() });
  const response = await request(app).get('/health').expect(200);

  assert.equal(response.body.status, 'ok');
  assert.ok(response.body.python?.python, 'python path ausente no healthcheck');
});

test('accepts a job request and processes asynchronously', async () => {
  const registry = new Map<string, SandboxJob>();
  const app = createApp({ jobRegistry: registry, processor: new StubProcessor() });
  const payload = {
    jobId: 'job-123',
    repoUrl: 'https://github.com/example/repo.git',
    branch: 'main',
    taskDescription: 'fix failing tests',
    testCommand: 'npm test',
  };

  const creation = await request(app).post('/jobs').send(payload).expect(201);
  assert.equal(creation.body.jobId, payload.jobId);
  assert.ok(['PENDING', 'RUNNING', 'COMPLETED'].includes(creation.body.status));

  // processor runs asynchronously and updates registry
  const stored = registry.get(payload.jobId);
  assert.ok(stored);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stored!.status, 'COMPLETED');
  assert.deepEqual(stored!.changedFiles, ['README.md']);
});

test('returns existing job idempotently', async () => {
  const registry = new Map<string, SandboxJob>();
  const processor = new StubProcessor();
  const app = createApp({ jobRegistry: registry, processor });
  const payload = {
    jobId: 'job-abc',
    repoUrl: 'https://github.com/example/repo.git',
    branch: 'develop',
    taskDescription: 'refactor',
  };

  const first = await request(app).post('/jobs').send(payload).expect(201);
  const second = await request(app).post('/jobs').send(payload).expect(200);

  assert.equal(first.body.jobId, payload.jobId);
  assert.equal(second.body.jobId, payload.jobId);
});

test('rejects invalid payload', async () => {
  const app = createApp({ processor: new StubProcessor() });
  await request(app).post('/jobs').send({}).expect(400);
});

test('accepts upload job with problem files', async () => {
  const registry = new Map<string, SandboxJob>();
  const app = createApp({ jobRegistry: registry, processor: new StubProcessor() });
  const zip = new AdmZip();
  zip.addFile('README.md', Buffer.from('hello upload attachments'));
  const payload = {
    jobId: 'job-upload-problem-files',
    taskDescription: 'investigar erro',
    uploadedZip: { base64: zip.toBuffer().toString('base64'), filename: 'source.zip' },
    problemFiles: [{ base64: Buffer.from('Linha 1;erro').toString('base64'), filename: 'erros.csv' }],
  };

  await request(app).post('/jobs').send(payload).expect(201);

  const stored = registry.get(payload.jobId);
  assert.ok(stored?.problemFiles);
  assert.equal(stored?.problemFiles?.length, 1);
  assert.equal(stored?.problemFiles?.[0].filename, 'erros.csv');
});

test('accepts upload job without repo url', async () => {
  const registry = new Map<string, SandboxJob>();
  const app = createApp({ jobRegistry: registry, processor: new StubProcessor() });
  const zip = new AdmZip();
  zip.addFile('README.md', Buffer.from('hello upload'));
  const payload = {
    jobId: 'job-upload-1',
    taskDescription: 'analyze upload',
    uploadedZip: { base64: zip.toBuffer().toString('base64'), filename: 'source.zip' },
  };

  const creation = await request(app).post('/jobs').send(payload).expect(201);
  assert.equal(creation.body.branch, 'upload');

  const stored = registry.get(payload.jobId);
  assert.ok(stored?.uploadedZip?.base64);
  assert.equal(stored?.repoUrl, `upload://${payload.jobId}`);
});

test('accepts upload jobs larger than the default JSON limit', async () => {
  const registry = new Map<string, SandboxJob>();
  const app = createApp({ jobRegistry: registry, processor: new StubProcessor() });
  const largeBase64 = Buffer.alloc(150_000, 'a').toString('base64');
  const payload = {
    jobId: 'job-upload-large-body',
    taskDescription: 'process large upload',
    uploadedZip: { base64: largeBase64, filename: 'source.zip' },
  };

  const creation = await request(app).post('/jobs').send(payload).expect(201);
  assert.equal(creation.body.jobId, payload.jobId);

  const stored = registry.get(payload.jobId);
  const storedBase64 = stored?.uploadedZip?.base64;
  assert.ok(storedBase64);
  assert.ok(storedBase64!.length >= largeBase64.length);
});

test('materializa credenciais do GCP no sandbox e exporta variáveis para run_shell', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-gcp-creds-'));
  const repoPath = path.join(workspace, 'repo');
  await fs.mkdir(repoPath, { recursive: true });

  const processor = new SandboxJobProcessor();
  const credentialContent = '{"type":"service_account","project_id":"demo"}';
  const job: SandboxJob = {
    jobId: 'job-gcp-creds',
    repoUrl: 'upload://job-gcp-creds',
    branch: 'upload',
    taskDescription: 'noop',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sandboxPath: workspace,
    applicationDefaultCredentials: {
      base64: Buffer.from(credentialContent).toString('base64'),
      filename: 'application_default_credentials.json',
    },
  } as SandboxJob;

  await (processor as any).materializeApplicationDefaultCredentials(job);

  const expectedPath = path.join(workspace, '.config', 'gcloud', 'application_default_credentials.json');
  const saved = await fs.readFile(expectedPath, 'utf-8');
  assert.equal(saved, credentialContent);
  assert.equal(job.gcpCredentialsPath, expectedPath);

  const result = await (processor as any).handleRunShell(
    { command: ['sh', '-c', 'echo $HOME && echo $GOOGLE_APPLICATION_CREDENTIALS && echo $CLOUDSDK_CONFIG'], cwd: '.' },
    repoPath,
    job,
  );

  const [homeEnv, credentialsEnv, cloudConfigEnv] = result.stdout.trim().split('\n');
  assert.equal(homeEnv, workspace);
  assert.equal(credentialsEnv, expectedPath);
  assert.equal(cloudConfigEnv, path.dirname(expectedPath));

  await fs.rm(workspace, { recursive: true, force: true });
});

test('materializa chave SSH personalizada para jobs de upload', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-ssh-key-'));
  const repoPath = path.join(workspace, 'repo');
  await fs.mkdir(repoPath, { recursive: true });

  const processor = new SandboxJobProcessor();
  const keyContent = '-----BEGIN OPENSSH PRIVATE KEY-----\nMOCKKEYDATA';
  const job: SandboxJob = {
    jobId: 'job-ssh-key',
    repoUrl: 'upload://job-ssh-key',
    branch: 'upload',
    taskDescription: 'noop',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sandboxPath: workspace,
    gitSshPrivateKey: { base64: Buffer.from(keyContent).toString('base64'), filename: 'gitlab_key' },
  } as SandboxJob;

  await (processor as any).materializeGitSshPrivateKey(job);

  const keyPath = path.join(workspace, '.ssh', 'id_ed25519');
  const savedKey = await fs.readFile(keyPath, 'utf-8');
  assert.equal(savedKey, keyContent);
  assert.equal(job.gitSshKeyPath, keyPath);

  const config = await fs.readFile(path.join(workspace, '.ssh', 'config'), 'utf-8');
  assert.ok(config.includes(keyPath));

  const envResult = await (processor as any).handleRunShell(
    { command: ['sh', '-c', 'echo $GIT_SSH_COMMAND'], cwd: '.' },
    repoPath,
    job,
  );
  assert.ok(envResult.stdout.includes(keyPath));

  await fs.rm(workspace, { recursive: true, force: true });
});

test('materializa token do GitLab e gera settings do Maven', async () => {
  await withGitlabSettingsBackup(async (settingsPath) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-gitlab-token-'));
    const repoPath = path.join(workspace, 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    const pom = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
  <repositories>
    <repository>
      <id>bvsnet-internal</id>
      <url>https://gitlab.bvsnet.com.br/-/package-router/maven</url>
    </repository>
  </repositories>
</project>`;
    await fs.writeFile(path.join(repoPath, 'pom.xml'), pom);

    const processor = new SandboxJobProcessor();
    const token = 'glpat-1234567890';
    const now = new Date().toISOString();
    const job: SandboxJob = {
      jobId: 'job-gitlab-token',
      repoUrl: 'upload://job-gitlab-token',
      branch: 'upload',
      taskDescription: 'noop',
      status: 'PENDING',
      logs: [],
      createdAt: now,
      updatedAt: now,
      sandboxPath: workspace,
      gitlabPersonalAccessToken: { base64: Buffer.from(token).toString('base64'), filename: 'gitlab.key' },
    } as SandboxJob;

    try {
      await (processor as any).materializeGitlabPersonalAccessToken(job, repoPath);

      const settings = await fs.readFile(settingsPath, 'utf-8');
      assert.ok(settings.includes('bvsnet-internal'));
      assert.ok(settings.includes(token));

      const envResult = await (processor as any).handleRunShell(
        { command: ['sh', '-c', 'echo $GITLAB_PERSONAL_ACCESS_TOKEN'], cwd: '.' },
        repoPath,
        job,
      );
      assert.equal(envResult.stdout.trim(), token);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

test('reaplica token do GitLab substituindo snippet existente sem duplicar blocos', async () => {
  await withGitlabSettingsBackup(async (settingsPath) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-gitlab-token-refresh-'));
    const repoPath = path.join(workspace, 'repo');
    await fs.mkdir(repoPath, { recursive: true });
    const pom = `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.0.0</version>
  <repositories>
    <repository>
      <id>bvsnet-internal</id>
      <url>https://gitlab.bvsnet.com.br/-/package-router/maven</url>
    </repository>
  </repositories>
</project>`;
    await fs.writeFile(path.join(repoPath, 'pom.xml'), pom);

    const processor = new SandboxJobProcessor();
    const firstToken = 'glpat-0000000001';
    const job: SandboxJob = {
      jobId: 'job-gitlab-token-refresh',
      repoUrl: 'upload://job-gitlab-token-refresh',
      branch: 'upload',
      taskDescription: 'noop',
      status: 'PENDING',
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sandboxPath: workspace,
      gitlabPersonalAccessToken: { base64: Buffer.from(firstToken).toString('base64'), filename: 'gitlab.key' },
    } as SandboxJob;

    try {
      await (processor as any).materializeGitlabPersonalAccessToken(job, repoPath);

      const secondToken = 'glpat-9999999999';
      job.gitlabPersonalAccessToken = { base64: Buffer.from(secondToken).toString('base64'), filename: 'gitlab.key' };
      await (processor as any).materializeGitlabPersonalAccessToken(job, repoPath);

      const settings = await fs.readFile(settingsPath, 'utf-8');
      const occurrences = settings.match(/<!-- ai-hub gitlab token start -->/g)?.length ?? 0;
      assert.equal(occurrences, 1, 'blocos do Maven devem ser únicos');
      assert.ok(settings.includes(secondToken));
      assert.ok(!settings.includes(firstToken));
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

test('falha com mensagem clara quando arquivo enviado no campo de PAT é uma chave SSH', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-gitlab-token-invalid-'));
  const repoPath = path.join(workspace, 'repo');
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(path.join(repoPath, 'pom.xml'), '<project/>');

  const processor = new SandboxJobProcessor();
  const now = new Date().toISOString();
  const sshPrivateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----`;
  const job: SandboxJob = {
    jobId: 'job-gitlab-token-invalid',
    repoUrl: 'upload://job-gitlab-token-invalid',
    branch: 'upload',
    taskDescription: 'noop',
    status: 'PENDING',
    logs: [],
    createdAt: now,
    updatedAt: now,
    sandboxPath: workspace,
    gitlabPersonalAccessToken: { base64: Buffer.from(sshPrivateKey).toString('base64'), filename: 'id_ed25519.key' },
  } as SandboxJob;

  await assert.rejects(
    async () => {
      await (processor as any).materializeGitlabPersonalAccessToken(job, repoPath);
    },
    /parece ser uma chave privada SSH/,
  );

  await fs.rm(workspace, { recursive: true, force: true });
});


test('processamento de upload materializa credenciais e chave SSH no workspace', async () => {
  const zip = new AdmZip();
  zip.addFile('README.md', Buffer.from('conteúdo com credenciais'));

  const fakeOpenAI = {
    responses: {
      create: async () => ({
        output: [
          {
            type: 'message',
            id: 'msg-upload-creds',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'ok', annotations: [] }],
          },
        ],
      }),
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  (processor as any).cleanup = async () => {};

  const credentialContent = '{"type":"service_account","project_id":"upload-demo"}';
  const sshKeyContent = '-----BEGIN OPENSSH PRIVATE KEY-----\nUPLOADKEYDATA';

  const now = new Date().toISOString();
  const job: SandboxJob = {
    jobId: 'job-upload-creds',
    repoUrl: 'upload://job-upload-creds',
    branch: 'upload',
    taskDescription: 'validar credenciais',
    status: 'PENDING',
    logs: [],
    createdAt: now,
    updatedAt: now,
    uploadedZip: { base64: zip.toBuffer().toString('base64'), filename: 'fontes.zip' },
    applicationDefaultCredentials: {
      base64: Buffer.from(credentialContent).toString('base64'),
      filename: 'application_default_credentials.json',
    },
    gitSshPrivateKey: { base64: Buffer.from(sshKeyContent).toString('base64'), filename: 'gitlab_key' },
  } as SandboxJob;

  await processor.process(job);

  assert.ok(job.sandboxPath, 'sandboxPath deve ser preenchido após o processamento');
  const gcpPath = job.gcpCredentialsPath!;
  const sshPath = job.gitSshKeyPath!;

  const savedCreds = await fs.readFile(gcpPath, 'utf-8');
  const savedKey = await fs.readFile(sshPath, 'utf-8');

  assert.equal(savedCreds, credentialContent);
  assert.equal(savedKey, sshKeyContent);
  assert.equal(path.basename(gcpPath), 'application_default_credentials.json');
  assert.equal(path.basename(sshPath), 'id_ed25519');

  const repoPathUpload = path.join(job.sandboxPath!, 'repo');
  const envCheck = await (processor as any).handleRunShell(
    { command: ['sh', '-c', 'echo $GOOGLE_APPLICATION_CREDENTIALS && echo $GIT_SSH_COMMAND'], cwd: '.' },
    repoPathUpload,
    job,
  );

  const [credentialsEnv, gitEnv] = envCheck.stdout.trim().split('\n');
  assert.equal(credentialsEnv, gcpPath);
  assert.ok(gitEnv.includes(sshPath));

  await fs.rm(job.sandboxPath!, { recursive: true, force: true });
});
test('respects SANDBOX_WORKDIR when creating workspaces', async () => {
  const originalWorkdir = process.env.SANDBOX_WORKDIR;
  const customBase = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-custom-base-'));
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-custom-repo-'));

  try {
    process.env.SANDBOX_WORKDIR = customBase;

    execSync('git init', { cwd: tempRepo });
    execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
    execSync('git config user.name "CI Bot"', { cwd: tempRepo });
    await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
    execSync('git add README.md', { cwd: tempRepo });
    execSync('git commit -m "init"', { cwd: tempRepo });
    execSync('git branch -M main', { cwd: tempRepo });

    const fakeOpenAI = {
      responses: {
        create: async () => ({
          output: [
            {
              type: 'message',
              id: 'msg-workdir',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ],
        }),
      },
    } as any;

    const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
    const job: SandboxJob = {
      jobId: 'job-custom-workdir',
      repoUrl: tempRepo,
      branch: 'main',
      taskDescription: 'noop',
      status: 'PENDING',
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as SandboxJob;

    await processor.process(job);

    assert.ok(job.sandboxPath?.startsWith(path.join(customBase, 'ai-hub-corporativo-')));
    assert.ok(job.logs.some((entry) => entry.includes(customBase)));
  } finally {
    if (originalWorkdir === undefined) {
      delete process.env.SANDBOX_WORKDIR;
    } else {
      process.env.SANDBOX_WORKDIR = originalWorkdir;
    }
    await fs.rm(tempRepo, { recursive: true, force: true });
    await fs.rm(customBase, { recursive: true, force: true });
  }
});

test('limits oversized task descriptions before calling the model', async () => {
  const originalLimit = process.env.TASK_DESCRIPTION_MAX_CHARS;
  process.env.TASK_DESCRIPTION_MAX_CHARS = '50';

  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-long-task-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        return {
          output: [
            {
              type: 'message',
              id: 'msg-truncated',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-long-task',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'x'.repeat(200),
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  const firstCall = fakeOpenAI.calls[0];
  const userMessage = firstCall.input.find((msg: any) => msg.role === 'user');
  const text = userMessage?.content?.find((item: any) => item.type === 'input_text')?.text ?? '';

  assert.ok(text.length <= 50, 'taskDescription should be truncated before sending to model');
  assert.ok(text.includes('truncated'), 'truncation hint should be present');
  assert.ok(job.logs.some((entry) => entry.includes('taskDescription com 200 caracteres')));

  if (originalLimit === undefined) {
    delete process.env.TASK_DESCRIPTION_MAX_CHARS;
  } else {
    process.env.TASK_DESCRIPTION_MAX_CHARS = originalLimit;
  }

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('returns job status', async () => {
  const registry = new Map<string, SandboxJob>();
  const processor = new StubProcessor();
  const app = createApp({ jobRegistry: registry, processor });
  registry.set('job-1', {
    jobId: 'job-1',
    repoUrl: 'https://example',
    branch: 'main',
    taskDescription: 'noop',
    status: 'COMPLETED',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    changedFiles: [],
  });

  const response = await request(app).get('/jobs/job-1').expect(200);
  assert.equal(response.body.jobId, 'job-1');
});

test('makes problem files available to the model inside the sandbox', async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-problem-files-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        return {
          output: [
            {
              type: 'message',
              id: 'msg-problem-files',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  (processor as any).cleanup = async () => {};
  const job: SandboxJob = {
    jobId: 'job-problem-files',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'analisar arquivos de problema',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    problemFiles: [
      { base64: Buffer.from('erro linha 1').toString('base64'), filename: 'erros.txt' },
    ],
  } as SandboxJob;

  await processor.process(job);

  const workspace = job.sandboxPath!;
  const problemFilePath = path.join(workspace, 'repo', '.aihub', 'problem-files', 'erros.txt');
  const content = await fs.readFile(problemFilePath, 'utf-8');
  assert.equal(content, 'erro linha 1');

  const systemMessage = fakeOpenAI.calls[0].input.find((item: any) => item.role === 'system');
  const systemText = systemMessage?.content?.find((c: any) => c.type === 'input_text')?.text ?? '';
  assert.ok(systemText.includes('.aihub/problem-files'), 'system message should mention problem files');
  assert.ok(systemText.includes('erros.txt'));

  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('processes tool calls inside a sandbox', async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-job-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call-1',
                name: 'write_file',
                arguments: JSON.stringify({ path: 'README.md', content: 'updated content' }),
              },
              { type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              id: 'msg-2',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'summary ready', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-tools',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'update file',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  const firstCall = fakeOpenAI.calls[0];
  assert.ok(firstCall.tools, 'tools ausente na chamada inicial');
  assert.deepEqual(
    firstCall.tools.map((tool: any) => tool.name ?? tool.function?.name).filter(Boolean),
    ['run_shell', 'read_file', 'write_file', 'http_get']
  );

  assert.equal(job.status, 'COMPLETED', job.error);
  assert.equal(job.summary, 'summary ready');
  assert.ok(job.patch && job.patch.includes('updated content'));
  assert.ok(job.logs.some((entry) => entry.includes('write_file')));

  const secondCall = fakeOpenAI.calls[1];
  const functionCall = secondCall.input.find((msg: any) => msg.type === 'function_call');
  assert.equal(functionCall?.id, 'call-1');
  assert.equal(functionCall?.call_id, 'call-1');

  const toolMessage = secondCall.input.find((msg: any) => msg.type === 'function_call_output');
  assert.ok(toolMessage?.id.startsWith('fco_'), 'function_call_output id sem prefixo fco_');
  assert.equal(toolMessage?.call_id, 'call-1');
  const parsedTool = JSON.parse(toolMessage.output);
  assert.equal(parsedTool.path, 'README.md');
  assert.equal(parsedTool.content, 'updated content');

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('truncates tool outputs before sending them back to the model', async () => {
  const originalStringLimit = process.env.TOOL_OUTPUT_STRING_LIMIT;
  const originalSerializedLimit = process.env.TOOL_OUTPUT_SERIALIZED_LIMIT;
  process.env.TOOL_OUTPUT_STRING_LIMIT = '80';
  process.env.TOOL_OUTPUT_SERIALIZED_LIMIT = '120';

  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-tool-output-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'y'.repeat(300));
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call-read-long',
                name: 'read_file',
                arguments: JSON.stringify({ path: 'README.md' }),
              },
              { type: 'message', id: 'msg-read-long', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              id: 'msg-read-long-2',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-tool-truncation',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'read long file',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  const secondCall = fakeOpenAI.calls[1];
  const toolMessage = secondCall.input.find((msg: any) => msg.type === 'function_call_output');
  assert.ok(toolMessage, 'mensagem de tool ausente');

  const output = toolMessage?.output ?? '';
  assert.ok(output.length <= 120, 'tool output must respect serialized limit');

  const parsed = JSON.parse(output);
  assert.ok(parsed.content.includes('truncated'), 'conteúdo deve indicar truncamento');
  assert.ok(parsed.content.length <= 80, 'tool output string deve respeitar limite configurado');
  assert.ok(job.logs.some((entry) => entry.includes('output de tool truncado')));

  if (originalStringLimit === undefined) {
    delete process.env.TOOL_OUTPUT_STRING_LIMIT;
  } else {
    process.env.TOOL_OUTPUT_STRING_LIMIT = originalStringLimit;
  }

  if (originalSerializedLimit === undefined) {
    delete process.env.TOOL_OUTPUT_SERIALIZED_LIMIT;
  } else {
    process.env.TOOL_OUTPUT_SERIALIZED_LIMIT = originalSerializedLimit;
  }

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('collects patch and changed files even when the model commits changes', async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-job-commit-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        const turn = fakeOpenAI.calls.length;
        if (turn === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'write-file',
                name: 'write_file',
                arguments: JSON.stringify({ path: 'README.md', content: 'committed change' }),
              },
              { type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        if (turn === 2) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'add',
                name: 'run_shell',
                arguments: JSON.stringify({ command: ['git', 'add', 'README.md'], cwd: '.' }),
              },
              { type: 'message', id: 'msg-2', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        if (turn === 3) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'commit',
                name: 'run_shell',
                arguments: JSON.stringify({ command: ['git', 'commit', '-m', 'model-commit'], cwd: '.' }),
              },
              { type: 'message', id: 'msg-3', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              id: 'msg-4',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'committed summary', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-commit',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'commit flow',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  assert.equal(job.status, 'COMPLETED', job.error);
  assert.equal(job.summary, 'committed summary');
  assert.ok(job.patch && job.patch.includes('committed change'), 'patch vazio após commit do modelo');
  assert.deepEqual(job.changedFiles, ['README.md']);

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('normalizes read_file path to repo-relative when sending tool outputs', async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-read-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call-read-1',
                name: 'read_file',
                arguments: JSON.stringify({ path: 'README.md' }),
              },
              { type: 'message', id: 'msg-read', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              id: 'msg-read-2',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'done', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-read-path',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'read a file',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  const secondCall = fakeOpenAI.calls[1];
  const toolMessage = secondCall.input.find((msg: any) => msg.type === 'function_call_output');
  assert.ok(toolMessage, 'mensagem da ferramenta ausente');
  const parsedOutput = JSON.parse(toolMessage.output);
  assert.equal(parsedOutput.path, 'README.md');
  assert.equal(parsedOutput.content, 'initial');

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('returns tool errors to the model instead of failing the job', async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-error-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call-error-1',
                name: 'read_file',
                arguments: JSON.stringify({ path: 'package.json' }),
              },
              { type: 'message', id: 'msg-err', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        const toolMessage = payload.input.find((msg: any) => msg.type === 'function_call_output');
        const parsed = toolMessage ? JSON.parse(toolMessage.output) : {};
        return {
          output: [
            {
              type: 'message',
              id: 'msg-err-2',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: parsed.error ? 'handled missing file' : 'no error',
                  annotations: [],
                },
              ],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-error',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'read a missing file',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  const secondCall = fakeOpenAI.calls[1];
  const toolMessage = secondCall.input.find((msg: any) => msg.type === 'function_call_output');
  assert.ok(toolMessage, 'mensagem de ferramenta ausente');
  const parsedOutput = JSON.parse(toolMessage.output);
  assert.ok(parsedOutput.error, 'tool error deve ser retornado ao modelo');
  assert.equal(job.status, 'COMPLETED');
  assert.equal(job.summary, 'handled missing file');

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('http_get fetches public content while sanitizing headers and truncating body', async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-http-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'http-call',
                name: 'http_get',
                arguments: JSON.stringify({ url: 'https://example.com/docs', headers: { Authorization: 'x', Accept: 'text/plain' } }),
              },
              { type: 'message', id: 'msg-http-1', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              id: 'msg-http-2',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'http ok', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const fetchCalls: any[] = [];
  const fakeFetch = async (input: string | URL, init?: any) => {
    fetchCalls.push({ input, init });
    return {
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'text/plain']]),
      text: async () => 'conteúdo público'.repeat(5),
    } as any;
  };

  const originalLimit = process.env.HTTP_TOOL_MAX_RESPONSE_CHARS;
  process.env.HTTP_TOOL_MAX_RESPONSE_CHARS = '20';

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI, fakeFetch);
  const job: SandboxJob = {
    jobId: 'job-http',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'fetch docs',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  const callOutput = fakeOpenAI.calls[1].input.find((msg: any) => msg.type === 'function_call_output');
  const parsed = JSON.parse(callOutput.output);
  assert.equal(parsed.status, 200);
  assert.equal(parsed.headers['content-type'], 'text/plain');
  assert.ok(parsed.truncated, 'body deve estar truncado');
  assert.ok(parsed.body.includes('truncated'), 'resposta deve indicar truncamento do corpo');
  assert.equal(job.summary, 'http ok');
  assert.ok(fetchCalls[0].init?.headers);
  assert.ok(!('authorization' in fetchCalls[0].init.headers));

  if (originalLimit === undefined) {
    delete process.env.HTTP_TOOL_MAX_RESPONSE_CHARS;
  } else {
    process.env.HTTP_TOOL_MAX_RESPONSE_CHARS = originalLimit;
  }

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('http_get blocks private addresses and returns an error to the model', async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-http-block-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'http-block',
                name: 'http_get',
                arguments: JSON.stringify({ url: 'http://127.0.0.1:8080' }),
              },
              { type: 'message', id: 'msg-http-block-1', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        const toolMessage = payload.input.find((msg: any) => msg.type === 'function_call_output');
        const parsed = toolMessage ? JSON.parse(toolMessage.output) : {};
        return {
          output: [
            {
              type: 'message',
              id: 'msg-http-block-2',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: parsed.error ? 'http error propagated' : 'no error',
                  annotations: [],
                },
              ],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-http-block',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'fetch forbidden',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  const toolMessage = fakeOpenAI.calls[1].input.find((msg: any) => msg.type === 'function_call_output');
  const parsed = JSON.parse(toolMessage.output);
  assert.ok(parsed.error?.includes('bloqueado') || parsed.error?.includes('permitidas'));
  assert.equal(job.summary, 'http error propagated');
  assert.equal(job.status, 'COMPLETED');

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('propagates tool errors for a single call id', async () => {
  const tempRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-dir-error-'));
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.email "ci@example.com"', { cwd: tempRepo });
  execSync('git config user.name "CI Bot"', { cwd: tempRepo });
  await fs.writeFile(path.join(tempRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: tempRepo });
  execSync('git commit -m "init"', { cwd: tempRepo });
  execSync('git branch -M main', { cwd: tempRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call-dir-error',
                name: 'read_file',
                arguments: JSON.stringify({ path: '.' }),
              },
              { type: 'message', id: 'msg-dir', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        const outputs = payload.input.filter((msg: any) => msg.type === 'function_call_output');
        return {
          output: [
            {
              type: 'message',
              id: 'msg-dir-2',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: outputs.length > 0 ? 'errors returned' : 'missing outputs',
                  annotations: [],
                },
              ],
            },
          ],
        };
      },
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-dir-error',
    repoUrl: tempRepo,
    branch: 'main',
    taskDescription: 'try to read directory',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  await processor.process(job);

  const secondCall = fakeOpenAI.calls[1];
  const outputs = secondCall.input.filter((msg: any) => msg.type === 'function_call_output');

  assert.equal(outputs.length, 1, 'apenas um call_id deve receber output');
  const parsed = JSON.parse(outputs[0].output);
  assert.equal(outputs[0].call_id, 'call-dir-error');
  assert.ok(parsed.error, 'erro da ferramenta deve ser propagado');
  assert.equal(job.status, 'COMPLETED');
  assert.equal(job.summary, 'errors returned');

  await fs.rm(tempRepo, { recursive: true, force: true });
});

test('pushes changes and opens a pull request when credentials are present', async () => {
  const bareRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-pr-remote-'));
  execSync('git init --bare', { cwd: bareRepo });

  const seedRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-pr-seed-'));
  execSync('git init', { cwd: seedRepo });
  execSync('git config user.email "ci@example.com"', { cwd: seedRepo });
  execSync('git config user.name "CI Bot"', { cwd: seedRepo });
  await fs.writeFile(path.join(seedRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: seedRepo });
  execSync('git commit -m "init"', { cwd: seedRepo });
  execSync('git branch -M main', { cwd: seedRepo });
  execSync(`git remote add origin ${bareRepo}`, { cwd: seedRepo });
  execSync('git push origin main', { cwd: seedRepo });

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call-pr-1',
                name: 'write_file',
                arguments: JSON.stringify({ path: 'README.md', content: 'updated for pr' }),
              },
              { type: 'message', id: 'msg-pr', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              id: 'msg-pr-2',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'pr ready', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const fetchCalls: any[] = [];
  const fakeFetch = async (input: string | URL, init?: any) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 201,
      json: async () => ({ html_url: 'https://github.com/example/repo/pull/1' }),
      text: async () => 'ok',
    } as any;
  };

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI, fakeFetch);
  const job: SandboxJob = {
    jobId: 'job-pr',
    repoSlug: 'example/repo',
    repoUrl: bareRepo,
    branch: 'main',
    taskDescription: 'update readme',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  const originalToken = process.env.GITHUB_PR_TOKEN;
  process.env.GITHUB_PR_TOKEN = 'fake-token';

  await processor.process(job);

  const heads = execSync(`git ls-remote ${bareRepo} refs/heads/ai-hub-corporativo/cifix-${job.jobId}`);
  assert.ok(heads.toString().includes(`ai-hub-corporativo/cifix-${job.jobId}`));
  assert.equal(job.pullRequestUrl, 'https://github.com/example/repo/pull/1');
  assert.ok(fetchCalls.length > 0, 'fetch não foi chamado para criar PR');
  assert.ok(
    fetchCalls[0].url.endsWith('/repos/example/repo/pulls'),
    'PR deve ser criado no endpoint de pulls do repositório',
  );

  process.env.GITHUB_PR_TOKEN = originalToken;
  await fs.rm(bareRepo, { recursive: true, force: true });
  await fs.rm(seedRepo, { recursive: true, force: true });
});

test('limits pull request title and keeps full summary in body', async () => {
  const bareRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-pr-long-remote-'));
  execSync('git init --bare', { cwd: bareRepo });

  const seedRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-pr-long-seed-'));
  execSync('git init', { cwd: seedRepo });
  execSync('git config user.email "ci@example.com"', { cwd: seedRepo });
  execSync('git config user.name "CI Bot"', { cwd: seedRepo });
  await fs.writeFile(path.join(seedRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: seedRepo });
  execSync('git commit -m "init"', { cwd: seedRepo });
  execSync('git branch -M main', { cwd: seedRepo });
  execSync(`git remote add origin ${bareRepo}`, { cwd: seedRepo });
  execSync('git push origin main', { cwd: seedRepo });

  const longSummary = 'a'.repeat(300);
  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call-pr-long-1',
                name: 'write_file',
                arguments: JSON.stringify({ path: 'README.md', content: 'updated for pr' }),
              },
              { type: 'message', id: 'msg-pr-long', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              id: 'msg-pr-long-2',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: longSummary, annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const fetchCalls: any[] = [];
  const fakeFetch = async (input: string | URL, init?: any) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 201,
      json: async () => ({ html_url: 'https://github.com/example/repo/pull/3' }),
      text: async () => 'ok',
    } as any;
  };

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI, fakeFetch);
  const job: SandboxJob = {
    jobId: 'job-pr-long',
    repoSlug: 'example/repo',
    repoUrl: bareRepo,
    branch: 'main',
    taskDescription: 'update readme',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  const originalToken = process.env.GITHUB_PR_TOKEN;
  process.env.GITHUB_PR_TOKEN = 'fake-token';

  await processor.process(job);

  const payload = JSON.parse(fetchCalls[0].init.body);
  assert.ok(payload.title.length <= 256, 'título do PR deve respeitar o limite do GitHub');
  assert.equal(payload.title, `AI Hub: ${longSummary.slice(0, 247)}…`);
  assert.ok(
    payload.body.includes(longSummary),
    'corpo do PR deve conter o resumo completo, sem truncar',
  );
  assert.ok(payload.body.includes('Descrição da tarefa'), 'corpo do PR deve incluir a tarefa');

  process.env.GITHUB_PR_TOKEN = originalToken;
  await fs.rm(bareRepo, { recursive: true, force: true });
  await fs.rm(seedRepo, { recursive: true, force: true });
});

test('reuses repository credentials from repoUrl when creating a pull request', async () => {
  const bareRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-pr-url-'));
  execSync('git init --bare', { cwd: bareRepo });

  const seedRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-pr-url-seed-'));
  execSync('git init', { cwd: seedRepo });
  execSync('git config user.email "ci@example.com"', { cwd: seedRepo });
  execSync('git config user.name "CI Bot"', { cwd: seedRepo });
  await fs.writeFile(path.join(seedRepo, 'README.md'), 'initial');
  execSync('git add README.md', { cwd: seedRepo });
  execSync('git commit -m "init"', { cwd: seedRepo });
  execSync('git branch -M main', { cwd: seedRepo });
  execSync(`git remote add origin ${bareRepo}`, { cwd: seedRepo });
  execSync('git push origin main', { cwd: seedRepo });

  const repoUrl = bareRepo;

  const fakeOpenAI = {
    calls: [] as any[],
    responses: {
      create: async (payload: any) => {
        fakeOpenAI.calls.push(payload);
        if (fakeOpenAI.calls.length === 1) {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'call-pr-url-1',
                name: 'write_file',
                arguments: JSON.stringify({ path: 'README.md', content: 'updated via url token' }),
              },
              { type: 'message', id: 'msg-pr-url', role: 'assistant', status: 'completed', content: [] },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              id: 'msg-pr-url-2',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'pr ready from url token', annotations: [] }],
            },
          ],
        };
      },
    },
  } as any;

  const fetchCalls: any[] = [];
  const fakeFetch = async (input: string | URL, init?: any) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    return {
      ok: true,
      status: 201,
      json: async () => ({ html_url: 'https://github.com/example/repo/pull/2' }),
      text: async () => 'ok',
    } as any;
  };

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI, fakeFetch);
  const originalClone = (processor as any).cloneRepository?.bind(processor);
  (processor as any).cloneRepository = async (...args: any[]) => {
    if (originalClone) {
      await originalClone(...args);
    }
    delete process.env.GITHUB_CLONE_TOKEN;
    delete process.env.GITHUB_TOKEN;
  };
  const job: SandboxJob = {
    jobId: 'job-pr-url',
    repoSlug: 'example/repo',
    repoUrl,
    branch: 'main',
    taskDescription: 'update readme',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as SandboxJob;

  const originalPrToken = process.env.GITHUB_PR_TOKEN;
  const originalCloneToken = process.env.GITHUB_CLONE_TOKEN;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_PR_TOKEN;
  process.env.GITHUB_CLONE_TOKEN = 'embedded-token';
  delete process.env.GITHUB_TOKEN;

  await processor.process(job);

  const pushedBranch = execSync(`git ls-remote ${bareRepo} refs/heads/ai-hub-corporativo/cifix-${job.jobId}`);
  assert.ok(pushedBranch.toString().includes(`ai-hub-corporativo/cifix-${job.jobId}`));
  assert.equal(job.pullRequestUrl, 'https://github.com/example/repo/pull/2');
  assert.ok(fetchCalls.length > 0, 'fetch não foi chamado para criar PR');
  assert.ok(
    fetchCalls[0].init?.headers?.Authorization.includes('embedded-token'),
    'token do repoUrl deve ser reutilizado ao criar PR',
  );

  if (originalPrToken === undefined) {
    delete process.env.GITHUB_PR_TOKEN;
  } else {
    process.env.GITHUB_PR_TOKEN = originalPrToken;
  }
  if (originalCloneToken === undefined) {
    delete process.env.GITHUB_CLONE_TOKEN;
  } else {
    process.env.GITHUB_CLONE_TOKEN = originalCloneToken;
  }
  if (originalGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN;
  } else {
    process.env.GITHUB_TOKEN = originalGithubToken;
  }

  await fs.rm(bareRepo, { recursive: true, force: true });
  await fs.rm(seedRepo, { recursive: true, force: true });
});


test('processes uploaded zip without cloning git', async () => {
  const zip = new AdmZip();
  zip.addFile('README.md', Buffer.from('initial content'));

  const fakeOpenAI = {
    responses: {
      create: async () => ({
        output: [
          {
            type: 'message',
            id: 'msg-upload',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done', annotations: [] }],
          },
        ],
      }),
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  const job: SandboxJob = {
    jobId: 'job-upload-process',
    repoUrl: 'upload://job-upload-process',
    branch: 'upload',
    taskDescription: 'noop',
    status: 'PENDING',
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    uploadedZip: { base64: zip.toBuffer().toString('base64'), filename: 'code.zip' },
  } as SandboxJob;

  await processor.process(job);

  assert.equal(job.status, 'COMPLETED');
  assert.ok(job.logs.some((entry) => entry.includes('upload')));
});


test('upload jobs disponibilizam zip final com fontes ajustados', async () => {
  const sourceZip = new AdmZip();
  sourceZip.addFile('README.md', Buffer.from('conteúdo inicial'));

  const fakeOpenAI = {
    responses: {
      create: async () => ({
        output: [
          {
            type: 'message',
            id: 'msg-upload-zip',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done', annotations: [] }],
          },
        ],
      }),
    },
  } as any;

  const processor = new SandboxJobProcessor(undefined, 'gpt-5-codex', fakeOpenAI);
  (processor as any).cleanup = async () => {};

  const now = new Date().toISOString();
  const job: SandboxJob = {
    jobId: 'job-upload-zip',
    repoUrl: 'upload://job-upload-zip',
    branch: 'upload',
    taskDescription: 'ajustar fontes do upload',
    status: 'PENDING',
    logs: [],
    createdAt: now,
    updatedAt: now,
    uploadedZip: { base64: sourceZip.toBuffer().toString('base64'), filename: 'fontes.zip' },
  } as SandboxJob;

  await processor.process(job);

  assert.equal(job.status, 'COMPLETED');
  assert.ok(job.resultZipBase64, 'resultZipBase64 deve estar preenchido');
  assert.ok(job.resultZipFilename?.endsWith('.zip'), 'resultZipFilename deve ser um zip');

  const buffer = Buffer.from(job.resultZipBase64!, 'base64');
  assert.ok(buffer.byteLength > 0, 'zip final não pode estar vazio');
  const resultZip = new AdmZip(buffer);
  const entries = resultZip.getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes('README.md'));
  assert.ok(entries.every((entry) => !entry.startsWith('.git/')));
});

test('mantém workspace quando SANDBOX_KEEP_WORKSPACE=true', async () => {
  const originalKeepWorkspace = process.env.SANDBOX_KEEP_WORKSPACE;
  process.env.SANDBOX_KEEP_WORKSPACE = 'true';

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-keep-workspace-'));
  const processor = new SandboxJobProcessor();

  await (processor as any).cleanup(workspace);

  const stat = await fs.stat(workspace);
  assert.ok(stat.isDirectory());

  await fs.rm(workspace, { recursive: true, force: true });
  if (originalKeepWorkspace === undefined) {
    delete process.env.SANDBOX_KEEP_WORKSPACE;
  } else {
    process.env.SANDBOX_KEEP_WORKSPACE = originalKeepWorkspace;
  }
});

test('remove workspace quando SANDBOX_KEEP_WORKSPACE não está habilitado', async () => {
  const originalKeepWorkspace = process.env.SANDBOX_KEEP_WORKSPACE;
  delete process.env.SANDBOX_KEEP_WORKSPACE;

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-clean-workspace-'));
  const processor = new SandboxJobProcessor();

  await (processor as any).cleanup(workspace);

  const existsAfterCleanup = await fs.access(workspace).then(() => true).catch(() => false);
  assert.equal(existsAfterCleanup, false);


  if (originalKeepWorkspace === undefined) {
    delete process.env.SANDBOX_KEEP_WORKSPACE;
  } else {
    process.env.SANDBOX_KEEP_WORKSPACE = originalKeepWorkspace;
  }
});
