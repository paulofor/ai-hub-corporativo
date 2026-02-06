import { exec as execCallback, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import OpenAI from 'openai';
import {
  ResponseFunctionToolCallItem,
  ResponseFunctionToolCallOutputItem,
  ResponseItem,
  ResponseOutputMessage,
  ResponseOutputText,
} from 'openai/resources/responses/responses.js';

import { buildAuthRepoUrl, extractTokenFromRepoUrl, redactUrlCredentials } from './git.js';
import { JobProcessor, SandboxJob, SandboxProfile } from './types.js';

const exec = promisify(execCallback);

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export class SandboxJobProcessor implements JobProcessor {
  private readonly openai?: OpenAI;
  private readonly model: string;
  private readonly fetchImpl?: (input: string | URL, init?: any) => Promise<any>;
  private readonly githubApiBase: string;
  private readonly maxTaskDescriptionChars: number;
  private readonly toolOutputStringLimit: number;
  private readonly toolOutputSerializedLimit: number;
  private readonly httpToolTimeoutMs: number;
  private readonly httpToolMaxResponseChars: number;
  private readonly economyModel?: string;
  private readonly economyMaxTaskDescriptionChars: number;
  private readonly economyToolOutputStringLimit: number;
  private readonly economyToolOutputSerializedLimit: number;
  private readonly economyHttpToolMaxResponseChars: number;
  private readonly keepWorkspace: boolean;

  constructor(
    apiKey?: string,
    model = 'gpt-5-codex',
    openaiClient?: OpenAI,
    fetchImpl: (input: string | URL, init?: any) => Promise<any> = globalThis.fetch,
  ) {
    this.model = model;
    if (openaiClient) {
      this.openai = openaiClient;
    } else if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
    this.fetchImpl = fetchImpl;
    this.githubApiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com';
    this.maxTaskDescriptionChars = this.parsePositiveInteger(process.env.TASK_DESCRIPTION_MAX_CHARS, 12_000);
    this.toolOutputStringLimit = this.parsePositiveInteger(process.env.TOOL_OUTPUT_STRING_LIMIT, 12_000);
    this.toolOutputSerializedLimit = this.parsePositiveInteger(process.env.TOOL_OUTPUT_SERIALIZED_LIMIT, 60_000);
    this.httpToolTimeoutMs = this.parsePositiveInteger(process.env.HTTP_TOOL_TIMEOUT_MS, 15_000);
    this.httpToolMaxResponseChars = this.parsePositiveInteger(process.env.HTTP_TOOL_MAX_RESPONSE_CHARS, 20_000);
    const configuredEconomyModel = process.env.CIFIX_MODEL_ECONOMY ?? process.env.CIFIX_ECONOMY_MODEL;
    if (configuredEconomyModel && configuredEconomyModel.trim()) {
      this.economyModel = configuredEconomyModel.trim();
    } else if (this.model === 'gpt-5-codex') {
      this.economyModel = 'gpt-4.1-mini';
    } else {
      this.economyModel = this.model;
    }

    const economyTaskLimitRaw = this.parsePositiveInteger(
      process.env.ECONOMY_TASK_DESCRIPTION_MAX_CHARS,
      Math.min(this.maxTaskDescriptionChars, 6_000),
    );
    this.economyMaxTaskDescriptionChars = Math.min(economyTaskLimitRaw, this.maxTaskDescriptionChars);

    const economyToolOutputLimitRaw = this.parsePositiveInteger(
      process.env.ECONOMY_TOOL_OUTPUT_STRING_LIMIT,
      Math.min(this.toolOutputStringLimit, 6_000),
    );
    this.economyToolOutputStringLimit = Math.min(economyToolOutputLimitRaw, this.toolOutputStringLimit);

    const economyToolOutputSerializedLimitRaw = this.parsePositiveInteger(
      process.env.ECONOMY_TOOL_OUTPUT_SERIALIZED_LIMIT,
      Math.min(this.toolOutputSerializedLimit, 15_000),
    );
    this.economyToolOutputSerializedLimit = Math.min(
      economyToolOutputSerializedLimitRaw,
      this.toolOutputSerializedLimit,
    );

    const economyHttpMaxCharsRaw = this.parsePositiveInteger(
      process.env.ECONOMY_HTTP_TOOL_MAX_RESPONSE_CHARS,
      Math.min(this.httpToolMaxResponseChars, 8_000),
    );
    this.economyHttpToolMaxResponseChars = Math.min(economyHttpMaxCharsRaw, this.httpToolMaxResponseChars);
    this.keepWorkspace = this.parseBoolean(process.env.SANDBOX_KEEP_WORKSPACE, false);
  }

  async process(job: SandboxJob): Promise<void> {
    job.status = 'RUNNING';
    job.updatedAt = new Date().toISOString();

    job.profile = (job.profile ?? 'STANDARD') as SandboxProfile;
    const resolvedModel = this.resolveModel(job);
    job.model = resolvedModel;

    const workspace = await this.prepareWorkspace(job);
    const repoPath = path.join(workspace, 'repo');
    job.sandboxPath = workspace;
    this.log(job, `workspace criado em ${workspace}`);
    this.log(job, `perfil ${job.profile} selecionado; modelo ${resolvedModel}`);
    if (this.isEconomy(job)) {
      this.log(
        job,
        `modo econômico: limite prompt=${this.economyMaxTaskDescriptionChars}, toolOutput=${this.economyToolOutputStringLimit}, http_get=${this.economyHttpToolMaxResponseChars}`,
      );
    }

    try {
      await this.materializeApplicationDefaultCredentials(job);
      await this.materializeGitSshPrivateKey(job);

      const isUpload = this.isUploadJob(job);
      let baseCommit: string | undefined;
      let githubAuth: { token?: string; username: string; source: string } | undefined;

      if (isUpload) {
        baseCommit = await this.prepareUploadedRepository(job, repoPath);
      } else {
        githubAuth = this.resolveGithubAuth(job);
        if (githubAuth.token) {
          this.log(
            job,
            `token GitHub obtido de ${githubAuth.source} será usado para clone, push e criação de PR`,
          );
        } else {
          this.log(job, 'nenhum token GitHub configurado; operações autenticadas podem falhar');
        }

        const cloneUrl = buildAuthRepoUrl(job.repoUrl, githubAuth.token, githubAuth.username);
        this.log(job, `clonando repositório ${redactUrlCredentials(cloneUrl)} (branch ${job.branch})`);
        await this.cloneRepository(job, repoPath, cloneUrl);
        baseCommit = await this.getHeadCommit(job, repoPath);
      }

      await this.materializeProblemFiles(job, repoPath);
      await this.materializeGitlabPersonalAccessToken(job, repoPath);

      if (!this.openai) {
        throw new Error('OPENAI_API_KEY não configurada no sandbox orchestrator');
      }

      this.log(job, `iniciando interação com o modelo do sandbox (${resolvedModel})`);
      const summary = await this.runCodexLoop(job, repoPath, resolvedModel);
      job.summary = summary;
      job.changedFiles = await this.collectChangedFiles(job, repoPath, baseCommit);
      job.patch = await this.generatePatch(job, repoPath, baseCommit);
      if (isUpload) {
        await this.attachResultZip(job, repoPath);
      }

      if (isUpload) {
        this.log(job, 'job criado via upload; PR automático será ignorado');
      } else if (githubAuth) {
        await this.maybeCreatePullRequest(job, repoPath, githubAuth, baseCommit, job.patch);
      }

      this.log(job, 'job concluído com sucesso, coletando patch e arquivos alterados');
      job.status = 'COMPLETED';
    } catch (error) {
      job.status = 'FAILED';
      job.error = error instanceof Error ? error.message : String(error);
      this.log(job, `falha ao processar job: ${job.error}`);
    } finally {
      job.updatedAt = new Date().toISOString();
      this.log(job, `limpando workspace ${workspace}`);
      await this.cleanup(workspace);
    }
  }

  private async prepareWorkspace(job: SandboxJob): Promise<string> {
    const baseDir = path.resolve(process.env.SANDBOX_WORKDIR ?? os.tmpdir());
    const sandboxEnv = process.env.SANDBOX_WORKDIR ?? '<não definido>';
    this.log(job, `preparando workspace (SANDBOX_WORKDIR=${sandboxEnv}) em ${baseDir}`);
    try {
      await fs.mkdir(baseDir, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(job, `falha ao criar diretório base ${baseDir}: ${message}`);
      throw new Error(`não foi possível preparar diretório base ${baseDir}: ${message}`);
    }

    try {
      const workspace = await fs.mkdtemp(path.join(baseDir, `ai-hub-corporativo-${job.jobId}-`));
      this.log(job, `workspace temporário usando ${baseDir} criado com prefixo ai-hub-corporativo-${job.jobId}-`);
      return workspace;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const baseDirStatus = await this.describePathStatus(baseDir);
      this.log(
        job,
        `falha ao criar workspace temporário em ${baseDir}: ${message} (status do diretório base: ${baseDirStatus})`,
      );
      throw new Error(`não foi possível criar workspace temporário em ${baseDir}: ${message}`);
    }
  }

  private resolveHomeDir(job: SandboxJob): string {
    if (job.sandboxPath && job.sandboxPath.trim()) {
      return job.sandboxPath;
    }
    return process.env.HOME ?? os.homedir();
  }

  private buildJobEnv(job: SandboxJob): NodeJS.ProcessEnv {
    const homeDir = this.resolveHomeDir(job);
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (homeDir) {
      env.HOME = homeDir;
    }

    if (job.gitSshKeyPath) {
      env.GIT_SSH_COMMAND = `ssh -i ${job.gitSshKeyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=no`;
    }
    if (job.gitlabPatValue) {
      env.GITLAB_PERSONAL_ACCESS_TOKEN = job.gitlabPatValue;
      env.GITLAB_PRIVATE_TOKEN = job.gitlabPatValue;
      env.MAVEN_GITLAB_TOKEN = job.gitlabPatValue;
    }

    const credentialsPath = job.gcpCredentialsPath;
    if (credentialsPath) {
      env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
      env.CLOUDSDK_CONFIG = path.dirname(credentialsPath);
    } else if (homeDir) {
      env.CLOUDSDK_CONFIG = path.join(homeDir, '.config', 'gcloud');
    }

    return env;
  }

  private async execWithJobEnv(command: string, options: { cwd?: string } = {}, job?: SandboxJob) {
    const env = job ? this.buildJobEnv(job) : process.env;
    return exec(command, { ...options, env });
  }

  private sanitizeCredentialFilename(name: string | undefined): string {
    const fallback = 'application_default_credentials.json';
    if (!name) {
      return fallback;
    }
    const normalized = path.basename(name.trim());
    if (!normalized || normalized === '.' || normalized === '..') {
      return fallback;
    }
    return normalized;
  }

  private async materializeApplicationDefaultCredentials(job: SandboxJob): Promise<void> {
    const credentials = job.applicationDefaultCredentials;
    if (!credentials?.base64) {
      this.log(job, 'nenhum arquivo de credenciais do GCP recebido');
      return;
    }

    const homeDir = this.resolveHomeDir(job);
    const targetDir = path.join(homeDir, '.config', 'gcloud');
    const filename = this.sanitizeCredentialFilename(credentials.filename);
    let buffer: Buffer;
    try {
      buffer = Buffer.from(credentials.base64, 'base64');
    } catch {
      throw new Error('arquivo de credenciais GCP inválido (base64)');
    }

    try {
      await fs.mkdir(targetDir, { recursive: true });
      const destination = path.join(targetDir, filename);
      await fs.writeFile(destination, buffer, { mode: 0o600 });
      job.gcpCredentialsPath = destination;
      this.log(
        job,
        `arquivo de credenciais GCP recebido (${credentials.filename ?? 'sem nome'}) e salvo em ${destination}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`não foi possível salvar credenciais do GCP: ${message}`);
    }
  }

  private resolveSshKeyFilename(): string {
    return 'id_ed25519';
  }

  private async materializeGitSshPrivateKey(job: SandboxJob): Promise<void> {
    const key = job.gitSshPrivateKey;
    if (!key?.base64) {
      this.log(job, 'nenhuma chave SSH enviada');
      return;
    }

    const homeDir = this.resolveHomeDir(job);
    const sshDir = path.join(homeDir, '.ssh');
    const filename = this.resolveSshKeyFilename();
    const originalName = key.filename?.trim();
    if (originalName && originalName !== filename) {
      this.log(job, `chave SSH enviada (${path.basename(originalName)}) será renomeada para ${filename}`);
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(key.base64, 'base64');
    } catch {
      throw new Error('chave SSH enviada é inválida (base64)');
    }

    try {
      await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`não foi possível preparar ~/.ssh: ${message}`);
    }

    const destination = path.join(sshDir, filename);
    await fs.writeFile(destination, buffer, { mode: 0o600 });
    try {
      await fs.chmod(destination, 0o600);
      await fs.chmod(sshDir, 0o700);
    } catch {
      // noop
    }

    await this.ensureSshConfig(job, sshDir, destination);
    job.gitSshKeyPath = destination;
    const relative = path.relative(homeDir, destination) || destination;
    this.log(
      job,
      `chave SSH recebida (${key.filename ?? 'sem nome'}) salva em ${relative}`,
    );
  }

  private async ensureSshConfig(job: SandboxJob, sshDir: string, keyPath: string): Promise<void> {
    const configPath = path.join(sshDir, 'config');
    const block = `# ai-hub ssh key
Host *
  IdentityFile ${keyPath}
  IdentitiesOnly yes
  StrictHostKeyChecking no

`;
    try {
      let existing = '';
      try {
        existing = await fs.readFile(configPath, 'utf-8');
      } catch {
        // arquivo inexistente será criado
      }
      const trimmed = existing.trimEnd();
      const content = trimmed ? `${trimmed}

${block}` : block;
      await fs.writeFile(configPath, content, { mode: 0o600 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(job, `não foi possível atualizar ~/.ssh/config: ${message}`);
    }
  }

  private async materializeGitlabPersonalAccessToken(job: SandboxJob, repoPath: string): Promise<void> {
    const tokenFile = job.gitlabPersonalAccessToken;
    if (!tokenFile?.base64) {
      this.log(job, 'nenhum token GitLab enviado');
      return;
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(tokenFile.base64, 'base64');
    } catch {
      throw new Error('token GitLab enviado é inválido (base64)');
    }

    const token = this.extractGitlabTokenFromFile(buffer.toString('utf-8'));
    if (!token) {
      this.log(job, 'token GitLab enviado está vazio; nenhuma credencial aplicada.');
      return;
    }

    const homeDir = this.resolveHomeDir(job);
    const secretsDir = path.join(homeDir, '.aihub');
    try {
      await fs.mkdir(secretsDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`não foi possível preparar diretório para token do GitLab: ${message}`);
    }

    const destination = path.join(secretsDir, tokenFile.filename?.trim() || 'gitlab-personal-access-token.key');
    await fs.writeFile(destination, `${token}\n`, { mode: 0o600 });
    job.gitlabPatPath = destination;
    job.gitlabPatValue = token;
    const relative = path.relative(homeDir, destination) || destination;
    this.log(job, `token GitLab recebido (${tokenFile.filename ?? 'sem nome'}) salvo em ${relative}`);

    await this.ensureGitlabMavenSettings(job, token, repoPath);
  }

  private extractGitlabTokenFromFile(content: string): string | undefined {
    if (!content) {
      return undefined;
    }

    const normalized = content.trim();
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(normalized)) {
      throw new Error(
        'token GitLab enviado parece ser uma chave privada SSH; envie um arquivo contendo apenas o PAT (glpat-...).',
      );
    }

    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return undefined;
    }
    for (const line of lines) {
      const separatorIndex = line.indexOf('=');
      if (separatorIndex >= 0) {
        const value = line.slice(separatorIndex + 1).trim();
        if (value) {
          return value;
        }
      } else if (line) {
        return line;
      }
    }
    return undefined;
  }

  private async ensureGitlabMavenSettings(job: SandboxJob, token: string, repoPath: string): Promise<void> {
    const homeDir = this.resolveHomeDir(job);
    const m2Dir = path.join(homeDir, '.m2');
    try {
      await fs.mkdir(m2Dir, { recursive: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`não foi possível preparar diretório ~/.m2: ${message}`);
    }

    const settingsPath = path.join(m2Dir, 'settings.xml');
    let existing = '';
    try {
      existing = await fs.readFile(settingsPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`não foi possível ler ${settingsPath}: ${message}`);
      }
    }

    const repoIds = await this.collectGitlabRepositoryIds(repoPath);
    if (repoIds.length === 0) {
      repoIds.push('gitlab-maven');
    }

    const snippet = this.buildGitlabServersSnippet(repoIds, token);
    const content = this.mergeMavenSettings(existing, snippet);
    try {
      await fs.writeFile(settingsPath, content, { mode: 0o600 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`não foi possível salvar ${settingsPath}: ${message}`);
    }
    const relative = path.relative(homeDir, settingsPath) || settingsPath;
    this.log(job, `arquivo ~/.m2/settings.xml atualizado (${relative}) para ${repoIds.join(', ')}`);
    const safeContent = this.redactSecrets(content, token);
    this.log(job, `conteúdo atual de ${relative} (redigido):\n${safeContent}`);
  }

  private mergeMavenSettings(existing: string, snippet: string): string {
    const start = '<!-- ai-hub gitlab token start -->';
    const end = '<!-- ai-hub gitlab token end -->';
    const markerRegex = new RegExp(`${start}[\s\S]*?${end}\n?`, 'g');
    const hasContent = existing && existing.trim().length > 0;
    if (!hasContent) {
      return this.wrapMavenSettings(snippet);
    }

    let sanitized = existing.replace(markerRegex, '');
    if (/<servers>/i.test(sanitized)) {
      return sanitized.replace(/<\/servers>/i, `${snippet}\n  </servers>`);
    }
    if (/<\/settings>/i.test(sanitized)) {
      return sanitized.replace(/<\/settings>/i, `  <servers>\n${snippet}\n  </servers>\n</settings>`);
    }
    return this.wrapMavenSettings(snippet);
  }

  private wrapMavenSettings(snippet: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 https://maven.apache.org/xsd/settings-1.0.0.xsd">\n  <servers>\n${snippet}\n  </servers>\n</settings>\n`;
  }

  private buildGitlabServersSnippet(ids: string[], token: string): string {
    const servers = ids
      .map(
        (id) => `    <server>\n      <id>${this.escapeXml(id)}</id>\n      <username>oauth2</username>\n      <password>${this.escapeXml(token)}</password>\n      <configuration>\n        <httpHeaders>\n          <property>\n            <name>Private-Token</name>\n            <value>${this.escapeXml(token)}</value>\n          </property>\n        </httpHeaders>\n      </configuration>\n    </server>`,
      )
      .join('\n');
    return `    <!-- ai-hub gitlab token start -->\n${servers}\n    <!-- ai-hub gitlab token end -->`;
  }

  private redactSecrets(content: string, secret: string): string {
    if (!content) {
      return content;
    }
    const escapedSecret = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const secretRegex = new RegExp(escapedSecret, 'g');
    return content.replace(secretRegex, '****');
  }

  private async collectGitlabRepositoryIds(repoPath: string): Promise<string[]> {
    const pomFiles = await this.findPomFiles(repoPath);
    const ids = new Set<string>();
    const urlPattern = /gitlab\.bvsnet\.com\.br\/-\/package-router\/maven/i;
    const repositoryRegex = /<(repository|pluginRepository)\b[\s\S]*?<\/\1>/gi;

    for (const pom of pomFiles) {
      let content: string;
      try {
        content = await fs.readFile(pom, 'utf-8');
      } catch {
        continue;
      }
      if (!urlPattern.test(content)) {
        continue;
      }
      repositoryRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = repositoryRegex.exec(content)) !== null) {
        const block = match[0];
        if (!urlPattern.test(block)) {
          continue;
        }
        const idMatch = block.match(/<id>([\s\S]*?)<\/id>/i);
        if (idMatch) {
          ids.add(idMatch[1].trim());
        }
      }
    }

    return Array.from(ids);
  }

  private async findPomFiles(dir: string, accumulator: string[] = []): Promise<string[]> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return accumulator;
    }

    const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.idea', '.vscode']);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) {
          continue;
        }
        await this.findPomFiles(path.join(dir, entry.name), accumulator);
        continue;
      }
      if (entry.isFile() && entry.name === 'pom.xml') {
        accumulator.push(path.join(dir, entry.name));
      }
    }
    return accumulator;
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private resolveGithubAuth(job: SandboxJob): { token?: string; username: string; source: string } {
    const username = process.env.GITHUB_CLONE_USERNAME ?? 'x-access-token';
    const candidates: Array<{ token?: string; source: string }> = [
      { token: process.env.GITHUB_CLONE_TOKEN, source: 'GITHUB_CLONE_TOKEN' },
      { token: process.env.GITHUB_TOKEN, source: 'GITHUB_TOKEN' },
      { token: process.env.GITHUB_PR_TOKEN, source: 'GITHUB_PR_TOKEN' },
      { token: extractTokenFromRepoUrl(job.repoUrl), source: 'repoUrl' },
    ];

    const selected = candidates.find((candidate) => candidate.token);
    return { token: selected?.token, username, source: selected?.source ?? 'nenhum' };
  }

  private async cleanup(workspace: string): Promise<void> {
    // Mantemos o workspace ao final do processamento para preservar artefatos
    // gerados durante o job (ex.: ~/.m2/settings.xml) para inspeção posterior.
    return;
  }

  private parseBoolean(rawValue: string | undefined, fallback: boolean): boolean {
    if (!rawValue || !rawValue.trim()) {
      return fallback;
    }
    const normalized = rawValue.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
    return fallback;
  }

  private async cloneRepository(job: SandboxJob, repoPath: string, cloneUrl: string): Promise<void> {
    await this.execWithJobEnv(`git clone --branch ${job.branch} --depth 1 ${cloneUrl} ${repoPath}`, {}, job);
    if (job.commitHash) {
      this.log(job, `checando commit ${job.commitHash}`);
      await this.execWithJobEnv(`git checkout ${job.commitHash}`, { cwd: repoPath }, job);
    }
  }

  private isUploadJob(job: SandboxJob): boolean {
    return Boolean(job.uploadedZip?.base64);
  }

  private async prepareUploadedRepository(job: SandboxJob, repoPath: string): Promise<string | undefined> {
    const upload = job.uploadedZip;
    if (!upload?.base64) {
      throw new Error('conteúdo do zip ausente no job');
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(upload.base64, 'base64');
    } catch {
      throw new Error('conteúdo do zip inválido (base64)');
    }

    this.log(
      job,
      `extraindo upload ${upload.filename ?? 'fonte.zip'} (${buffer.byteLength} bytes) para ${repoPath}`,
    );

    await fs.mkdir(repoPath, { recursive: true });
    await this.extractUploadedZip(job, buffer, repoPath);
    return this.initializeGitFromUpload(job, repoPath);
  }

  private async extractUploadedZip(job: SandboxJob, buffer: Buffer, targetDir: string): Promise<void> {
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`falha ao ler zip enviado: ${message}`);
    }

    const destination = path.resolve(targetDir);
    const entries = zip.getEntries();
    for (const entry of entries) {
      const normalized = path.normalize(entry.entryName).replace(/^\/+/, '');
      if (!normalized || normalized.startsWith('..')) {
        throw new Error(`entrada de zip inválida: ${entry.entryName}`);
      }

      const fullPath = path.resolve(path.join(destination, normalized));
      if (!fullPath.startsWith(destination)) {
        throw new Error(`entrada de zip aponta para fora do diretório de trabalho: ${entry.entryName}`);
      }

      if (entry.isDirectory) {
        await fs.mkdir(fullPath, { recursive: true });
        continue;
      }

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, entry.getData());
    }
    this.log(job, `upload extraído (${entries.length} entradas)`);
  }

  private async initializeGitFromUpload(job: SandboxJob, repoPath: string): Promise<string | undefined> {
    try {
      await this.execWithJobEnv('git init', { cwd: repoPath }, job);
      await this.execWithJobEnv('git config user.email "ai-hub-upload@example.com"', { cwd: repoPath }, job);
      await this.execWithJobEnv('git config user.name "AI Hub Upload"', { cwd: repoPath }, job);
      const branch = job.branch ?? 'upload';
      await this.execWithJobEnv(`git checkout -B ${branch}`, { cwd: repoPath }, job);
      await this.execWithJobEnv('git add -A', { cwd: repoPath }, job);
      try {
        await this.execWithJobEnv('git commit -m "Initial upload"', { cwd: repoPath }, job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(job, `nenhum commit inicial criado: ${message}`);
      }

      return await this.getHeadCommit(job, repoPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(job, `falha ao inicializar git para upload: ${message}`);
      return undefined;
    }
  }

  private problemFilesDir(repoPath: string): string {
    return path.join(repoPath, '.aihub', 'problem-files');
  }

  private sanitizeProblemFilename(name: string | undefined, index: number): string {
    const fallback = `problema-${index + 1}.txt`;
    if (!name) {
      return fallback;
    }
    const normalized = path.basename(name.trim()).replace(/[\/:]/g, '_');
    if (!normalized || normalized === '.' || normalized === '..') {
      return fallback;
    }
    return normalized;
  }

  private async materializeProblemFiles(job: SandboxJob, repoPath: string): Promise<void> {
    const files = job.problemFiles ?? [];
    if (files.length === 0) {
      return;
    }

    const targetDir = this.problemFilesDir(repoPath);
    try {
      await fs.mkdir(targetDir, { recursive: true });
      await this.ensureProblemFilesIgnored(job, repoPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`não foi possível preparar diretório para arquivos do problema: ${message}`);
    }

    const saved: string[] = [];
    for (const [index, file] of files.entries()) {
      const filename = this.sanitizeProblemFilename(file.filename, index);
      let buffer: Buffer;
      try {
        buffer = Buffer.from(file.base64, 'base64');
      } catch {
        throw new Error(`arquivo de problema ${filename} inválido (base64)`);
      }

      const destination = path.join(targetDir, filename);
      await fs.writeFile(destination, buffer);
      saved.push(filename);
    }

    const relative = path.relative(repoPath, targetDir) || '.';
    this.log(job, `arquivos de apoio do problema disponíveis em ${relative}: ${saved.join(', ')}`);
  }

  private async ensureProblemFilesIgnored(job: SandboxJob, repoPath: string): Promise<void> {
    const gitExclude = path.join(repoPath, '.git', 'info', 'exclude');
    const marker = '.aihub/';
    try {
      await fs.mkdir(path.dirname(gitExclude), { recursive: true });
      let existing = '';
      try {
        existing = await fs.readFile(gitExclude, 'utf-8');
      } catch {
        // noop: file will be created
      }
      if (!existing.includes(marker)) {
        await fs.appendFile(gitExclude, `${marker}
`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(job, `não foi possível registrar exclusão de arquivos do problema no git: ${message}`);
    }
  }

  private describeProblemFiles(job: SandboxJob, repoPath: string): string {
    const files = job.problemFiles ?? [];
    if (files.length === 0) {
      return '';
    }

    const dir = path.relative(repoPath, this.problemFilesDir(repoPath)) || '.';
    const names = files
      .map((file) => {
        const label = file.filename;
        return file.contentType ? `${label} [${file.contentType}]` : label;
      })
      .filter(Boolean);
    const list = names.length > 0 ? ` (arquivos: ${names.join(', ')})` : '';
    return `\nArquivos adicionais enviados pelo usuário (incluindo documentos ou imagens da solicitação) estão disponíveis em ${dir}${list}. Considere-os na investigação antes de sugerir ajustes.`;
  }

  private buildTools(repoPath: string) {
    return [
      {
        type: 'function' as const,
        name: 'run_shell',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'array', items: { type: 'string' } },
            cwd: { type: 'string', description: 'Diretório relativo ao repo' },
          },
          required: ['command', 'cwd'],
          additionalProperties: false,
        },
        strict: true,
        description: 'Executa um comando de shell dentro do sandbox clonado',
      },
      {
        type: 'function' as const,
        name: 'read_file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        strict: true,
        description: 'Lê um arquivo do repositório clonado',
      },
      {
        type: 'function' as const,
        name: 'write_file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        strict: true,
        description: 'Escreve um arquivo dentro do repositório clonado',
      },
      {
        type: 'function' as const,
        name: 'http_get',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'URL http(s) pública para consulta' },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Cabeçalhos opcionais; Authorization é ignorado',
            },
          },
          required: ['url'],
          additionalProperties: false,
        },
        strict: true,
        description: 'Busca um recurso público via HTTP GET (bloqueia hosts internos e localhost)',
      },
    ];
  }

  private async runCodexLoop(job: SandboxJob, repoPath: string, model: string): Promise<string> {
    job.taskDescription = this.sanitizeTaskDescription(job.taskDescription, job);

    const tools = this.buildTools(repoPath);
    const profileInstruction = this.isEconomy(job)
      ? `
Modo econômico ativo: minimize leituras extensas, priorize comandos curtos, escreva respostas objetivas e evite reexecuções desnecessárias.`
      : '';
    const problemFilesInstruction = this.describeProblemFiles(job, repoPath);
    const javaDecompilerInstruction = '\nO utilitário `cfr` está instalado para decompilar arquivos .class de Java: execute `cfr <arquivo.class>` para gerar uma versão legível do código.';
    const internetAccessInstruction =
      '\nSe precisar consultar documentação, artigos ou quaisquer materiais públicos na internet, use a tool `http_get` (somente requisições GET sem autenticação ou headers sensíveis).';
    const messages: ResponseItem[] = [
      {
        type: 'message',
        id: this.sanitizeId('msg_system'),
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: `Você está operando em um sandbox isolado em ${repoPath}. Use as tools para ler, alterar arquivos e executar comandos. Test command sugerido: ${
              job.testCommand ?? 'n/d'
            }. Sempre trabalhe somente dentro do diretório do repositório. Prefira usar o comando rg para buscas recursivas em vez de grep -R, que é mais lento.${profileInstruction}${problemFilesInstruction}${javaDecompilerInstruction}${internetAccessInstruction}`,
          },
        ],
      },
      {
        type: 'message',
        id: this.sanitizeId('msg_user'),
        role: 'user',
        content: [{ type: 'input_text', text: job.taskDescription }],
      },
    ];

    let summary = '';
    this.log(job, 'loop do modelo iniciado; aguardando chamadas de ferramenta');

    while (true) {
      this.log(job, `enviando mensagens para o modelo (mensagens=${messages.length}, tools=${tools.length})`);
      const response = await this.openai!.responses.create({
        model,
        input: messages,
        tools,
      });
      this.log(
        job,
        `resposta do modelo recebida (responseId=${response.id ?? 'n/d'}, output_items=${(response.output ?? []).length})`,
      );

      this.addUsageMetrics(job, (response as any).usage);

      const output = response.output ?? [];
      const normalizedOutput: ResponseItem[] = output.map((item, index) => {
        if (item.type === 'function_call') {
          const callId = this.extractCallId(item, index);
          const messageId = this.sanitizeId(item.id ?? callId);
          return { ...item, id: messageId, call_id: callId } as ResponseItem;
        }
        return item as ResponseItem;
      });
      const assistantMessage = normalizedOutput.find((item) => item.type === 'message') as ResponseOutputMessage | undefined;
      const toolCalls = normalizedOutput.filter((item) => item.type === 'function_call') as ResponseFunctionToolCallItem[];

      const toolCallDetails =
        toolCalls
          .map((call, idx) => {
            const callId = call.call_id ?? this.extractCallId(call, idx);
            return `${call.name ?? 'sem_nome'}(callId=${callId}, id=${call.id ?? 'n/d'})`;
          })
          .join(', ') || 'nenhum';
      const assistantTextPreview = this.truncate(this.extractOutputText(assistantMessage?.content) ?? '', 240);
      this.log(
        job,
        `modelo retornou ${toolCalls.length} chamadas de ferramenta e mensagem=${Boolean(
          assistantMessage,
        )} (toolCalls=[${toolCallDetails}], textPreview="${assistantTextPreview}")`,
      );

      const text = this.extractOutputText(assistantMessage?.content);
      if (toolCalls.length === 0) {
        summary = text ?? summary;
        if (assistantMessage) {
          messages.push(assistantMessage);
        }
        this.log(job, `resumo final do modelo: "${this.truncate(summary, 240)}"`);
        this.log(job, 'modelo concluiu sem novas tool calls');
        return summary;
      }

      messages.push(...normalizedOutput);

      const toolMessages: ResponseFunctionToolCallOutputItem[] = [];
      for (const [index, call] of toolCalls.entries()) {
        const parsedArgs = this.parseArguments(call.arguments);
        const callId = call.call_id ?? this.extractCallId(call, index);
        const outputId = this.normalizeFunctionCallOutputId(callId, `call_${index}`);
        const toolCall: ToolCall = {
          id: callId,
          name: call.name ?? '',
          arguments: parsedArgs ?? {},
        };
        this.log(
          job,
          `executando tool ${toolCall.name} (callId=${callId}, args=${JSON.stringify(toolCall.arguments)})`,
        );
        try {
          const result = await this.dispatchTool(toolCall, repoPath, job);
          this.logJson(job, `resultado da tool ${toolCall.name} (callId=${callId})`, result);
          toolMessages.push({
            id: outputId,
            call_id: callId,
            output: this.prepareToolOutput(result, job),
            type: 'function_call_output',
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log(job, `erro ao executar tool ${toolCall.name}: ${message}`);
          toolMessages.push({
            id: outputId,
            call_id: callId,
            output: this.prepareToolOutput({ error: message }, job),
            type: 'function_call_output',
          });
        }
      }

      messages.push(...toolMessages);
    }
  }

  private extractOutputText(content: ResponseOutputMessage['content'] | undefined): string | undefined {
    if (!Array.isArray(content)) {
      return undefined;
    }
    const texts = content
      .filter((item) => item.type === 'output_text')
      .map((item) => (item as ResponseOutputText).text.trim())
      .filter((text) => text.length > 0);

    if (texts.length === 0) {
      return undefined;
    }
    return texts.join('\n').trim();
  }

  private addUsageMetrics(job: SandboxJob, usage: unknown): void {
    if (!usage || typeof usage !== 'object') {
      return;
    }

    const source = usage as Record<string, unknown>;
    const promptTokens = this.readNumberField(source, ['prompt_tokens', 'input_tokens', 'promptTokens']);
    const completionTokens = this.readNumberField(source, [
      'completion_tokens',
      'output_tokens',
      'completionTokens',
    ]);
    const totalTokens =
      this.readNumberField(source, ['total_tokens', 'totalTokens']) ??
      (promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined);
    const cost = this.readNumberField(source, ['total_cost', 'cost']);

    if (promptTokens !== undefined) {
      job.promptTokens = (job.promptTokens ?? 0) + promptTokens;
    }
    if (completionTokens !== undefined) {
      job.completionTokens = (job.completionTokens ?? 0) + completionTokens;
    }
    if (totalTokens !== undefined) {
      job.totalTokens = (job.totalTokens ?? 0) + totalTokens;
    }
    if (cost !== undefined) {
      job.cost = (job.cost ?? 0) + cost;
    }
  }

  private readNumberField(source: Record<string, unknown>, candidates: string[]): number | undefined {
    for (const key of candidates) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return undefined;
  }

  private parseArguments(raw: unknown): Record<string, unknown> | undefined {
    if (!raw) {
      return undefined;
    }
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch (err) {
        return undefined;
      }
    }
    if (typeof raw === 'object') {
      return raw as Record<string, unknown>;
    }
    return undefined;
  }

  private async dispatchTool(call: ToolCall, repoPath: string, job: SandboxJob): Promise<unknown> {
    switch (call.name) {
      case 'run_shell':
        return this.handleRunShell(call.arguments, repoPath, job);
      case 'read_file':
        return this.handleReadFile(call.arguments, repoPath);
      case 'write_file':
        return this.handleWriteFile(call.arguments, repoPath, job);
      case 'http_get':
        return this.handleHttpGet(call.arguments, job);
      default:
        return { error: `Ferramenta desconhecida: ${call.name}` };
    }
  }

  private sanitizeHeaders(raw: unknown): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined;
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string') {
        continue;
      }
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === 'authorization') {
        continue;
      }
      headers[normalizedKey] = value;
    }

    return Object.keys(headers).length > 0 ? headers : undefined;
  }

  private validateExternalUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('URL inválida');
    }

    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Apenas URLs http(s) são permitidas');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '0.0.0.0' || hostname === '::1') {
      throw new Error('Acesso a hosts locais não é permitido');
    }

    const ipVersion = net.isIP(hostname);
    if (ipVersion === 4 || ipVersion === 6) {
      if (this.isPrivateIp(hostname, ipVersion)) {
        throw new Error('Acesso a endereços privados foi bloqueado');
      }
    }

    return parsed;
  }

  private isPrivateIp(host: string, version: 4 | 6): boolean {
    if (version === 6) {
      return host === '::1' || host.startsWith('fd') || host.startsWith('fc');
    }

    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => Number.isNaN(octet))) {
      return true;
    }

    const [a, b] = octets;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  private async handleHttpGet(args: Record<string, unknown>, job: SandboxJob) {
    if (!this.fetchImpl) {
      throw new Error('fetch indisponível para http_get');
    }

    const urlArg = typeof args.url === 'string' ? args.url : undefined;
    if (!urlArg) {
      throw new Error('url é obrigatório para http_get');
    }

    const url = this.validateExternalUrl(urlArg);
    const headers = this.sanitizeHeaders(args.headers);
    const maxResponseChars = this.resolveHttpToolMaxResponseChars(job);

    this.log(job, `http_get: ${url.toString()} (timeoutMs=${this.httpToolTimeoutMs}, maxResponseChars=${maxResponseChars})`);

    const controller = AbortSignal.timeout(this.httpToolTimeoutMs);
    let response: any;
    try {
      response = await this.fetchImpl(url.toString(), { method: 'GET', headers, signal: controller });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`falha ao buscar URL: ${message}`);
    }

    const headersObject: Record<string, string> = {};
    try {
      for (const [key, value] of response.headers?.entries?.() ?? []) {
        headersObject[key] = value;
      }
    } catch {
      // noop - headers optional
    }

    let body = '';
    let truncated = false;
    try {
      const text = await response.text();
      const truncation = this.truncateStringValue(text, maxResponseChars);
      body = truncation.value;
      truncated = truncation.truncated;
      if (truncation.truncated) {
        this.log(job, `http_get: corpo truncado (omitiu ${truncation.omitted} caracteres)`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`falha ao ler corpo da resposta: ${message}`);
    }

    return {
      url: url.toString(),
      status: typeof response.status === 'number' ? response.status : undefined,
      statusText: response.statusText,
      headers: headersObject,
      body,
      truncated,
    };
  }

  private resolvePath(repoPath: string, requested: string | undefined, job?: SandboxJob): string {
    if (!requested) {
      throw new Error('path ausente');
    }
    const sanitized = this.sanitizeRequestedPath(requested);
    if (!sanitized) {
      throw new Error('path ausente');
    }
    if (sanitized !== requested && job) {
      this.log(job, `normalizando caminho solicitado de "${requested}" para "${sanitized}"`);
    }
    const absolute = path.resolve(repoPath, sanitized);
    if (!absolute.startsWith(repoPath)) {
      throw new Error('Acesso a caminho fora do sandbox bloqueado');
    }
    return absolute;
  }

  private normalizeRepoPath(
    repoPath: string,
    requested: string | undefined,
  ): { absolute: string; relative: string } {
    const absolute = this.resolvePath(repoPath, requested);
    const relative = path.relative(repoPath, absolute) || path.basename(absolute);
    return { absolute, relative };
  }

  private async handleRunShell(args: Record<string, unknown>, repoPath: string, job: SandboxJob) {
    let command = Array.isArray(args.command) ? (args.command as string[]) : undefined;
    if (!command || command.length === 0) {
      throw new Error('command é obrigatório para run_shell');
    }
    const cwdArg = typeof args.cwd === 'string' ? args.cwd : undefined;
    const cwd = cwdArg ? this.resolvePath(repoPath, cwdArg, job) : repoPath;
    await this.assertDirectoryExists(cwd);

    command = command.map((part) => part.trim());
    const isRecursiveGrep = command[0] === 'grep' && command[1] === '-R';
    if (isRecursiveGrep && command.length <= 2) {
      const message = 'grep -R detectado. Use rg <padrao> <caminho> para buscas recursivas no sandbox.';
      this.log(job, message);
      throw new Error(message);
    }

    if (isRecursiveGrep) {
      const rgCommand = ['rg', ...command.slice(2)];
      this.log(
        job,
        `comando grep -R detectado; substituindo por rg para busca recursiva: ${command.join(' ')} -> ${rgCommand.join(
          ' ',
        )}`,
      );
      command = rgCommand;
    }

    const joined = command.join(' ');
    const timeoutEnv = Number(process.env.RUN_SHELL_TIMEOUT_MS);
    const defaultTimeoutMs = Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : 300_000;
    const isMavenCommand = path.basename(command[0]) === 'mvn';
    const mavenTimeoutMs = 15 * 60 * 1000;
    const timeoutMs = isMavenCommand ? Math.max(defaultTimeoutMs, mavenTimeoutMs) : defaultTimeoutMs;
    if (isMavenCommand && timeoutMs > defaultTimeoutMs) {
      this.log(job, 'mvn detectado; aumentando timeout para 15 minutos');
    }
    const maxBufferEnv = Number(process.env.RUN_SHELL_MAX_BUFFER_BYTES);
    const maxBuffer = Number.isFinite(maxBufferEnv) && maxBufferEnv > 0 ? maxBufferEnv : 5 * 1024 * 1024;

    this.log(
      job,
      `run_shell: ${joined} (cwd=${cwd}, timeoutMs=${timeoutMs}, maxBufferBytes=${maxBuffer})`,
    );

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const env = this.buildJobEnv(job);

    const child = spawn(command[0], command.slice(1), { cwd, env });

    const appendWithLimit = (current: string, chunk: string): { value: string; truncated: boolean } => {
      if (current.length >= maxBuffer) {
        return { value: current, truncated: true };
      }
      const remaining = maxBuffer - current.length;
      if (chunk.length <= remaining) {
        return { value: current + chunk, truncated: false };
      }
      return { value: current + chunk.slice(0, remaining), truncated: true };
    };

    child.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const result = appendWithLimit(stdout, chunk);
      stdout = result.value;
      stdoutTruncated = stdoutTruncated || result.truncated;
      this.log(job, `run_shell stdout: ${this.truncate(chunk, 500)}`);
    });

    child.stderr.on('data', (data: Buffer) => {
      const chunk = data.toString();
      const result = appendWithLimit(stderr, chunk);
      stderr = result.value;
      stderrTruncated = stderrTruncated || result.truncated;
      this.log(job, `run_shell stderr: ${this.truncate(chunk, 500)}`);
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      this.log(job, `run_shell atingiu timeout de ${timeoutMs}ms; finalizando processo`);
      child.kill('SIGKILL');
    }, timeoutMs);

    const exitResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timeoutHandle);
        resolve({ code, signal });
      });
    });

    if (stdoutTruncated || stderrTruncated) {
      this.log(job, 'run_shell output truncado para respeitar maxBuffer');
    }
    this.log(
      job,
      `run_shell finalizado (code=${exitResult.code}, signal=${exitResult.signal}, timedOut=${timedOut})`,
    );

    return {
      stdout,
      stderr,
      exitCode: exitResult.code,
      signal: exitResult.signal,
      timedOut,
      stdoutTruncated,
      stderrTruncated,
    };
  }

  private async handleReadFile(args: Record<string, unknown>, repoPath: string) {
    const { absolute, relative } = this.normalizeRepoPath(
      repoPath,
      typeof args.path === 'string' ? args.path : undefined,
    );
    const content = await fs.readFile(absolute, 'utf8');
    return { path: relative, content };
  }

  private async handleWriteFile(args: Record<string, unknown>, repoPath: string, job: SandboxJob) {
    const { absolute, relative } = this.normalizeRepoPath(
      repoPath,
      typeof args.path === 'string' ? args.path : undefined,
    );
    const content = typeof args.content === 'string' ? args.content : '';
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
    this.log(job, `write_file: ${absolute}`);
    return { status: 'ok', path: relative, content };
  }

  private async collectChangedFiles(job: SandboxJob, repoPath: string, baseCommit?: string): Promise<string[]> {
    if (!(await this.isGitRepository(repoPath))) {
      return [];
    }

    try {
      const { stdout } = await this.execWithJobEnv(`git diff --name-only ${baseCommit ?? 'HEAD'}`, { cwd: repoPath }, job);
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  private async generatePatch(job: SandboxJob, repoPath: string, baseCommit?: string): Promise<string> {
    if (!(await this.isGitRepository(repoPath))) {
      return '';
    }
    try {
      const { stdout } = await this.execWithJobEnv(`git diff ${baseCommit ?? 'HEAD'}`, { cwd: repoPath }, job);
      return stdout;
    } catch {
      return '';
    }
  }

  private async attachResultZip(job: SandboxJob, repoPath: string): Promise<void> {
    try {
      const resolvedRoot = path.resolve(repoPath);
      const zip = new AdmZip();
      zip.addLocalFolder(resolvedRoot, '', (entryPath) => this.shouldIncludeInResultZip(resolvedRoot, entryPath));
      const buffer = zip.toBuffer();
      job.resultZipBase64 = buffer.toString('base64');
      job.resultZipFilename = this.resolveResultZipFilename(job);
      this.log(job, `zip final com fontes gerado (${this.formatBytes(buffer.byteLength)})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(job, `falha ao gerar zip final com fontes: ${message}`);
    }
  }

  private shouldIncludeInResultZip(root: string, entryPath: string): boolean {
    const relative = path.relative(root, entryPath);
    if (!relative) {
      return true;
    }
    const normalized = relative.split(path.sep).filter(Boolean);
    return !normalized.some((segment) => segment === '.git');
  }

  private resolveResultZipFilename(job: SandboxJob): string {
    const original = job.uploadedZip?.filename;
    if (original) {
      const parsed = path.parse(original.trim());
      const base = parsed.name && parsed.name !== '.' ? parsed.name : 'upload';
      return `${base}-modificado.zip`;
    }
    return `${job.jobId}-resultado.zip`;
  }

  private formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  private async isGitRepository(repoPath: string): Promise<boolean> {
    try {
      await fs.stat(path.join(repoPath, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  private resolveRepoSlug(job: SandboxJob): string | undefined {
    if (job.repoSlug) {
      return job.repoSlug;
    }

    try {
      const parsed = new URL(job.repoUrl);
      if (parsed.hostname.toLowerCase() !== 'github.com') {
        return undefined;
      }
      const parts = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async getHeadCommit(job: SandboxJob, repoPath: string): Promise<string | undefined> {
    if (!(await this.isGitRepository(repoPath))) {
      return undefined;
    }
    try {
      const { stdout } = await this.execWithJobEnv('git rev-parse HEAD', { cwd: repoPath }, job);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  private async maybeCreatePullRequest(
    job: SandboxJob,
    repoPath: string,
    githubAuth: { token?: string; username: string; source: string },
    baseCommit?: string,
    diffPatch?: string,
  ): Promise<void> {
    const token = githubAuth.token;
    if (!token) {
      this.log(job, 'nenhum token GitHub disponível; ignorando criação de PR');
      return;
    }

    const repoSlug = this.resolveRepoSlug(job);
    if (!repoSlug) {
      this.log(job, 'repoSlug ausente e repoUrl não é github.com; não é possível criar PR');
      return;
    }

    if (!this.fetchImpl) {
      this.log(job, 'fetch API indisponível; não é possível criar PR');
      return;
    }

    if (!(await this.isGitRepository(repoPath))) {
      this.log(job, 'repositório git ausente, não é possível criar PR');
      return;
    }

    const diff = diffPatch ?? (await this.generatePatch(job, repoPath, baseCommit));
    if (!diff.trim()) {
      this.log(job, 'nenhuma alteração detectada; PR não será criado');
      return;
    }

    const branchName = `ai-hub-corporativo/cifix-${job.jobId}`;
    try {
      await this.execWithJobEnv('git config user.email "ai-hub-corporativo-bot@example.com"', { cwd: repoPath }, job);
      await this.execWithJobEnv('git config user.name "AI Hub Bot"', { cwd: repoPath }, job);
      await this.execWithJobEnv(`git checkout -B ${branchName}`, { cwd: repoPath }, job);
      await this.execWithJobEnv('git add -A', { cwd: repoPath }, job);
      await this.execWithJobEnv('git commit -m "AI Hub automated fix"', { cwd: repoPath }, job);

      const authenticatedRemote = buildAuthRepoUrl(
        job.repoUrl,
        token,
        githubAuth.username,
      );
      await this.execWithJobEnv(`git remote set-url origin ${authenticatedRemote}`, { cwd: repoPath }, job);
      try {
        await this.execWithJobEnv(`git push origin ${branchName}`, { cwd: repoPath }, job);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const hint = this.permissionHintFromMessage(message);
        throw new Error(
          `Falha ao fazer push para criar PR: ${message}${hint ? ` (${hint})` : ''}`,
        );
      }

      const prTitle = this.buildPrTitle(job.summary);
      const prBody = this.buildPrBody(job.summary, job.taskDescription);
      const response = await this.fetchImpl(`${this.githubApiBase}/repos/${repoSlug}/pulls`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          title: prTitle,
          head: branchName,
          base: job.branch,
          body: prBody,
        }),
      });

      if (!response.ok) {
        const message = (await response.text()) || 'erro desconhecido da API do GitHub';
        const permissionHint =
          response.status === 401 || response.status === 403
            ? 'token pode estar sem permissão de pull request ou push'
            : undefined;
        throw new Error(
          `Falha ao criar PR: ${response.status} ${message}${
            permissionHint ? ` (${permissionHint})` : ''
          }`,
        );
      }

      const pr = await response.json();
      if (pr?.html_url) {
        job.pullRequestUrl = pr.html_url;
        this.log(job, `pull request criado em ${job.pullRequestUrl}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(job, `falha ao criar pull request: ${message}`);
    }
  }

  private permissionHintFromMessage(message: string): string | undefined {
    const normalized = message.toLowerCase();
    if (normalized.includes('permission denied') || normalized.includes('authentication failed')) {
      return 'verifique se o token tem escopos de push e pull_request';
    }
    return undefined;
  }

  private log(job: SandboxJob, message: string) {
    const entry = `[${new Date().toISOString()}] ${message}`;
    job.logs.push(entry);
    console.info(`Sandbox job ${job.jobId}: ${message}`);
  }

  private async describePathStatus(target: string): Promise<string> {
    try {
      const stats = await fs.stat(target);
      if (stats.isDirectory()) {
        return 'diretório acessível';
      }
      return `existe mas não é diretório (mode=${stats.mode})`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `inacessível: ${message}`;
    }
  }

  private sanitizeRequestedPath(requested: string | undefined): string | undefined {
    if (!requested) {
      return undefined;
    }
    const trimmed = requested.trim();
    const withoutQuotes = trimmed.replace(/^['"`]+|['"`]+$/g, '');
    const withoutTrailingBraces = withoutQuotes.replace(/[}\]]+$/g, '');
    const sanitized = withoutTrailingBraces.trim();
    return sanitized.length > 0 ? sanitized : undefined;
  }

  private async assertDirectoryExists(cwd: string): Promise<void> {
    try {
      const stats = await fs.stat(cwd);
      if (!stats.isDirectory()) {
        throw new Error(`cwd não é um diretório: ${cwd}`);
      }
    } catch (err) {
      throw new Error(`cwd não encontrado: ${cwd}`);
    }
  }

  private extractCallId(item: { id?: string; call_id?: string }, index: number): string {
    const fallback = `call_${index}`;
    const rawId = item.call_id ?? item.id ?? fallback;
    if (typeof rawId === 'string' && rawId.trim().length > 0) {
      return rawId;
    }
    return fallback;
  }

  private normalizeFunctionCallOutputId(rawId: string | undefined, fallback: string): string {
    const base = rawId && rawId.length > 0 ? rawId : fallback;
    const sanitized = this.sanitizeId(base.replace(/^fco_/, ''));
    return sanitized.startsWith('fco_') ? sanitized : `fco_${sanitized}`;
  }

  private sanitizeId(id: string | undefined): string {
    if (!id) {
      return 'msg_default';
    }
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return sanitized.length > 0 ? sanitized : 'msg_default';
  }

  private buildPrTitle(summary?: string): string {
    const defaultTitle = 'AI Hub automated fix';
    const prefix = 'AI Hub: ';
    const maxLength = 256;

    if (!summary || summary.trim().length === 0) {
      return defaultTitle;
    }

    const availableForSummary = Math.max(1, maxLength - prefix.length);
    const truncatedSummary = this.truncateWithEllipsis(summary.trim(), availableForSummary);
    return `${prefix}${truncatedSummary}`;
  }

  private buildPrBody(summary: string | undefined, taskDescription: string): string {
    const sections = [
      'Correção automática gerada pelo sandbox do AI Hub.',
      taskDescription ? `\n**Descrição da tarefa:**\n${taskDescription}` : undefined,
      summary ? `\n**Resumo das alterações:**\n${summary}` : undefined,
    ].filter(Boolean);

    return sections.join('\n');
  }

  private truncateWithEllipsis(value: string, maxLength: number): string {
    if (!value || maxLength <= 0) {
      return '';
    }
    if (value.length <= maxLength) {
      return value;
    }
    if (maxLength === 1) {
      return value.slice(0, maxLength);
    }
    return `${value.slice(0, maxLength - 1)}…`;
  }

  private truncate(value: string, maxLength = 200): string {
    if (!value) {
      return '';
    }
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
  }

  private logJson(job: SandboxJob, prefix: string, payload: unknown, maxLength = 2000) {
    let serialized: string;
    try {
      serialized = JSON.stringify(payload);
    } catch (err) {
      serialized = `erro ao serializar payload: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.log(job, `${prefix}: ${this.truncate(serialized, maxLength)}`);
  }

  private sanitizeTaskDescription(description: string, job: SandboxJob): string {
    const { value, truncated, omitted } = this.truncateStringValue(description ?? '', this.maxTaskDescriptionChars);
    if (truncated) {
      this.log(
        job,
        `taskDescription com ${description.length} caracteres truncado para ${this.maxTaskDescriptionChars} para evitar erro de contexto (omitiu ${omitted} caracteres)`,
      );
    }
    return value;
  }

  private prepareToolOutput(result: unknown, job: SandboxJob): string {
    const stringLimit = this.resolveToolOutputStringLimit(job);
    const serializedLimit = this.resolveToolOutputSerializedLimit(job);
    const truncation = { truncated: false };
    const sanitized = this.truncateStringFields(result, stringLimit, truncation);
    let serialized: string;

    try {
      serialized = JSON.stringify(sanitized);
    } catch (err) {
      serialized = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }

    if (truncation.truncated) {
      this.log(
        job,
        `output de tool truncado para ${stringLimit} caracteres por campo para evitar ultrapassar a janela de contexto`,
      );
    }

    const { value, truncated, omitted } = this.truncateStringValue(serialized, serializedLimit);
    if (truncated) {
      this.log(
        job,
        `output serializado da tool excedeu ${serializedLimit} caracteres e foi truncado (omitiu ${omitted} caracteres)`
      );
    }
    return value;
  }

  private resolveModel(job: SandboxJob): string {
    const candidate = typeof job.model === 'string' ? job.model.trim() : '';
    if (candidate) {
      return candidate;
    }
    if (this.isEconomy(job) && this.economyModel) {
      return this.economyModel;
    }
    return this.model;
  }

  private isEconomy(job: SandboxJob): boolean {
    return (job.profile ?? 'STANDARD') === 'ECONOMY';
  }

  private resolveTaskDescriptionLimit(job: SandboxJob): number {
    return this.isEconomy(job) ? this.economyMaxTaskDescriptionChars : this.maxTaskDescriptionChars;
  }

  private resolveToolOutputStringLimit(job: SandboxJob): number {
    return this.isEconomy(job) ? this.economyToolOutputStringLimit : this.toolOutputStringLimit;
  }

  private resolveToolOutputSerializedLimit(job: SandboxJob): number {
    return this.isEconomy(job) ? this.economyToolOutputSerializedLimit : this.toolOutputSerializedLimit;
  }

  private resolveHttpToolMaxResponseChars(job: SandboxJob): number {
    return this.isEconomy(job) ? this.economyHttpToolMaxResponseChars : this.httpToolMaxResponseChars;
  }

  private truncateStringFields(value: unknown, maxLength: number, tracker: { truncated: boolean }): unknown {
    if (typeof value === 'string') {
      const truncated = this.truncateStringValue(value, maxLength);
      tracker.truncated = tracker.truncated || truncated.truncated;
      return truncated.value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.truncateStringFields(item, maxLength, tracker));
    }

    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.truncateStringFields(val, maxLength, tracker);
      }
      return result;
    }

    return value;
  }

  private truncateStringValue(value: string, maxLength: number): { value: string; truncated: boolean; omitted: number } {
    if (!Number.isFinite(maxLength) || maxLength <= 0 || value.length <= maxLength) {
      return { value, truncated: false, omitted: 0 };
    }

    const suffixBase = '... [truncated ';
    const suffixClose = ' chars]';
    const suffixLength = suffixBase.length + suffixClose.length + String(value.length).length;
    const available = Math.max(0, maxLength - suffixLength);
    const omitted = Math.max(0, value.length - available);
    const suffix = `${suffixBase}${omitted}${suffixClose}`;
    const truncatedValue = `${value.slice(0, available)}${suffix}`;

    return { value: truncatedValue, truncated: true, omitted };
  }

  private parsePositiveInteger(raw: string | undefined, defaultValue: number): number {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
  }
}
